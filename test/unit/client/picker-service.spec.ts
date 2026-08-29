// PickerService tests cover picker lifecycle, backend-access mirroring, model
// directory/live-option coordination, composer blocking, and new-session
// handoff. The fake scope follows Cordis effect semantics: setup runs now and
// its returned disposer runs during scope teardown. Assertions keep
// subscriptions alive until teardown and prevent recomputation afterwards.

import { describe, expect, it, vi } from 'vitest';
import { LiveOptionsController } from '../../../src/client/data/live-controller.ts';
import { PickerService, type PickerServiceDeps } from '../../../src/client/data/picker-service.ts';
import { createModelPickerStore } from '../../../src/client/data/stores/picker-store.ts';
import type { SessionModelsView } from '../../../src/client/data/selector-logic.ts';
import type { AcpRemoteLike, AcpRemoteResultLike } from '../../../src/client/data/acp-remote.ts';
import type { AcpLiveOptionsSnapshot } from '../../../src/contract/remote.ts';

const SESSION_ID = 'sess-1';

// ---------- 夹具 ----------

interface EffectRegistration {
  name: string | undefined;
  /** The disposer returned by the effect setup. */
  disposer: unknown;
}

const NEVER = new Promise<never>(() => {});

function createHarness() {
  const blocksLog: Array<{ sessionId: string; block: { reason: string } | undefined }> = [];
  const registrations: EffectRegistration[] = [];
  const projectionUnsub = vi.fn();
  const projectionSnapshots = new Map<string, unknown>();
  const projectionListeners = new Map<string, Set<() => void>>();
 // sessions.list 观察面 fake（新会话确认/导航的数据源）。
  let sessionListSnapshot: { byId: Record<string, { cwd?: string } | undefined>; current?: string } = { byId: {} };
  const sessionListListeners = new Set<() => void>();
  const openCalls: string[] = [];
  const commandCalls: Array<{ sessionId: string; line: string }> = [];
  // 目录 wire 应答可控：默认永不 resolve（prime 预拉停在 loading，测试保持纯同步），
  // 需要驱动目录转换的用例替换 modelsImpl。
  let modelsImpl: () => Promise<{ result: { ok: true; value: SessionModelsView } }> = () => NEVER;
  let modelsCalls = 0;

  const deps: PickerServiceDeps = {
    sessions: {
      scope: (sessionId) =>
        sessionId === SESSION_ID
          ? {
              // Cordis Fiber.effect executes setup immediately and retains the
              // returned disposer until fiber teardown.
              effect(fn, name) {
                const disposer = (fn as () => unknown)();
                registrations.push({ name, disposer });
                return () => {
                  if (typeof disposer === 'function') (disposer as () => void)();
                };
              },
            }
          : undefined,
      binding: (sessionId) =>
        sessionId === SESSION_ID || sessionListSnapshot.byId[sessionId] !== undefined
          ? {
              session: {
                command: (line) => {
                  commandCalls.push({ sessionId, line });
                  return Promise.resolve({ ok: true as const, value: { matched: true } });
                },
                projections: {
                  faceOf: (key) => ({
                    getSnapshot: () => projectionSnapshots.get(key),
                    subscribe(callback) {
                      const listeners = projectionListeners.get(key) ?? new Set<() => void>();
                      projectionListeners.set(key, listeners);
                      listeners.add(callback);
                      return () => {
                        listeners.delete(callback);
                        projectionUnsub();
                      };
                    },
                  }),
                },
              },
            }
          : undefined,
      list: {
        getSnapshot: () => sessionListSnapshot,
        subscribe(callback) {
          sessionListListeners.add(callback);
          return () => {
            sessionListListeners.delete(callback);
          };
        },
      },
      open: (sessionId) => {
        openCalls.push(sessionId);
      },
    },
    transport: {
        sessions: {
          models: () => {
            modelsCalls += 1;
            return modelsImpl();
          },
          selectModel: () => {
            throw new Error('unexpected selectModel');
          },
          create: () => {
            throw new Error('unexpected sessions.create');
          },
        },
        settings: {
          mutate: () => {
            throw new Error('unexpected settings.mutate');
          },
        },
    },
    remote: { $on: () => () => {} },
    acpRemote: {
      health: () => NEVER,
      options: () => NEVER,
      setOption: () => NEVER,
      backendOf: () => NEVER,
      rebindBlank: () => NEVER,
      boundSessions: () => NEVER,
      beginModelSwitch: () => NEVER,
      commitModelSwitch: () => NEVER,
      rollbackModelSwitch: () => NEVER,
    },
    conversation: {
      blocks: {
        set: (sessionId, block) => {
          blocksLog.push({ sessionId, block });
        },
      },
    },
    settingsScope: {
      getSnapshot: () => ({ status: 'idle', value: undefined, revision: 0, writable: false }),
    },
    t: (key) => key,
  };

  return {
    deps,
    blocksLog,
    registrations,
    projectionUnsub,
    openCalls,
    commandCalls,
    modelsCalls: () => modelsCalls,
    resolveModels(view: SessionModelsView) {
      modelsImpl = () => Promise.resolve({ result: { ok: true, value: view } });
    },
    setProjection(next: unknown) {
      projectionSnapshots.set('permissions', next);
      for (const listener of [...(projectionListeners.get('permissions') ?? [])]) listener();
    },
    setModelProjection(next: unknown) {
      projectionSnapshots.set('modelSelection', next);
      for (const listener of [...(projectionListeners.get('modelSelection') ?? [])]) listener();
    },
 /** 把一行会话发布进列表镜像（host session-added 帧的等价物）。 */
    publishSessionRow(sessionId: string, row: { cwd?: string } = {}) {
      sessionListSnapshot = { ...sessionListSnapshot, byId: { ...sessionListSnapshot.byId, [sessionId]: row } };
      for (const listener of [...sessionListListeners]) listener();
    },
    setCurrent(sessionId: string | undefined) {
      const { current: _current, ...rest } = sessionListSnapshot;
      sessionListSnapshot = sessionId === undefined ? rest : { ...rest, current: sessionId };
      for (const listener of [...sessionListListeners]) listener();
    },
  };
}

const UNROUTABLE_VIEW: SessionModelsView = {
  current: { provider: 'acp-mock', model: 'm1' },
  routable: false,
  groups: [],
  failures: [],
};

// ---------- 测试 ----------

describe('PickerService pickerFor 订阅生命周期', () => {
  it('pickerFor 返回后订阅存活；清理只随 effect 返回的 disposer 发生', async () => {
    const h = createHarness();
    const service = new PickerService(h.deps);

    const picker = service.pickerFor(SESSION_ID);

    // Effect setup has already run; its disposer is retained for teardown.
    expect(h.registrations).toHaveLength(1);
    expect(h.registrations[0]!.name).toBe(`dsh-acp:picker:${SESSION_ID}`);
    expect(typeof h.registrations[0]!.disposer).toBe('function');
    expect(h.projectionUnsub).not.toHaveBeenCalled();

    // Repeated lookup returns the cached picker without rebuilding it.
    expect(service.pickerFor(SESSION_ID)).toBe(picker);
    expect(h.registrations).toHaveLength(1);

    // attach 真 store 实例（seat 注入工厂的等价物）：三路 slice 一次 resync。
    const store = createModelPickerStore().create(SESSION_ID);
    picker.attach(store.actions);
    expect(store.getSnapshot().backendAccess).toEqual({ provider: '', preset: undefined });

    // 目录转换存活（行为钉）：glue 级 load 落地 routable=false → recompute →
    // 发布阻断 block，且镜像同步到 store。
    const callsBeforeDirectory = h.blocksLog.length;
    h.resolveModels(UNROUTABLE_VIEW);
    await picker.directory.load();
    expect(h.blocksLog.length).toBeGreaterThan(callsBeforeDirectory);
    expect(h.blocksLog.at(-1)).toEqual({
      sessionId: SESSION_ID,
      block: { reason: 'blocked.composer' },
    });
    expect(store.getSnapshot().directory.routable).toBe(false);
    expect(store.getSnapshot().backendAccess.provider).toBe('acp-mock');

    // permissions projection 订阅存活：快照变化触发 recompute（披露镜像更新）。
    const callsBeforeProjection = h.blocksLog.length;
    h.setProjection({ currentValue: 'danger-full-access' });
    expect(h.blocksLog.length).toBeGreaterThan(callsBeforeProjection);
    expect(store.getSnapshot().backendAccess.preset).toBe('danger-full-access');

    // (b) 调用 effect 返回的 disposer（= fiber 卸载路径）后清理发生。
    (h.registrations[0]!.disposer as () => void)();
    expect(h.projectionUnsub).toHaveBeenCalledTimes(2);
    expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });

    // 两路触发源已死：projection 退订 + recompute 惰性化——此后目录转换
    // （含 in-flight 落地）与 projection 变化都不再发布 block。
    const callsAfterDispose = h.blocksLog.length;
    await picker.directory.load();
    h.setProjection({ currentValue: 'read-only' });
    expect(h.blocksLog.length).toBe(callsAfterDispose);

    // picker 已摘除：再次 pickerFor 重建（新实例 + 第二次 effect 注册）。
    expect(service.pickerFor(SESSION_ID)).not.toBe(picker);
    expect(h.registrations).toHaveLength(2);
  });

  it('Alpha modelSelection projection 变化会重拉目录，避免 catalog 默认值长期冒充会话当前值', async () => {
    const h = createHarness();
    h.resolveModels(UNROUTABLE_VIEW);
    const service = new PickerService(h.deps);
    service.pickerFor(SESSION_ID);
    await vi.waitFor(() => { expect(h.modelsCalls()).toBeGreaterThanOrEqual(1); });

    const before = h.modelsCalls();
    h.setModelProjection({ next: { provider: 'acp-mock', model: 'm2' } });
    await vi.waitFor(() => { expect(h.modelsCalls()).toBeGreaterThan(before); });
  });

 it('ACP 权限投影降档后自动恢复 Full Access，同时披露 slice 跟随 projection', async () => {
    const h = createHarness();
    h.deps.acpRemote = {
      ...h.deps.acpRemote,
      backendOf: () => Promise.resolve({ ok: true as const, value: { state: 'established' as const, provider: 'acp-mock' } }),
    };
    h.setProjection({ currentValue: 'danger-full-access' });
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    const store = createModelPickerStore().create(SESSION_ID);
    picker.attach(store.actions);

    // 初始：目录未加载，但宿主权限投影已经是 Full Access。
    expect(store.getSnapshot().backendAccess).toEqual({ provider: '', preset: 'danger-full-access' });

    // 目录到位（ACP 路由）→ provider 先行就位。
    h.resolveModels({ ...UNROUTABLE_VIEW, routable: true });
    await picker.directory.load();
    expect(store.getSnapshot().backendAccess).toEqual({ provider: 'acp-mock', preset: 'danger-full-access' });
    expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });
    expect(h.commandCalls).toHaveLength(0);

    // 用户把 DSH 权限降档后，插件按 ACP backend 权威身份自动恢复。
    h.setProjection({ currentValue: 'read-only' });
    expect(store.getSnapshot().backendAccess.preset).toBe('read-only');
    await vi.waitFor(() => {
      expect(h.commandCalls).toEqual([{ sessionId: SESSION_ID, line: '/permission danger-full-access' }]);
    });
    h.setProjection({ currentValue: 'danger-full-access' });
    expect(store.getSnapshot().backendAccess.preset).toBe('danger-full-access');
    expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });
  });

  it('默认 ACP 创建出的 draft 会话自动启用 Full Access，无需重新选择 Agent', async () => {
    const h = createHarness();
    h.deps.acpRemote = {
      ...h.deps.acpRemote,
      backendOf: () => Promise.resolve({ ok: true as const, value: { state: 'draft' as const, provider: 'acp-mock' } }),
    };
    h.setProjection({ currentValue: 'workspace-write' });
    h.resolveModels({ ...UNROUTABLE_VIEW, routable: true });

    const service = new PickerService(h.deps);
    await service.pickerFor(SESSION_ID).directory.load();

    await vi.waitFor(() => {
      expect(h.commandCalls).toEqual([{ sessionId: SESSION_ID, line: '/permission danger-full-access' }]);
    });
  });

  it('空白页的全局 Kimi 影子不会覆盖实际 Codex wrapper 的页面选择', async () => {
    const h = createHarness();
    h.deps.acpRemote = {
      ...h.deps.acpRemote,
      backendOf: () => Promise.resolve({
        ok: true as const,
        value: { state: 'draft' as const, provider: 'acp-codex', model: 'codex-mini' },
      }),
    };
    h.setProjection({ currentValue: 'danger-full-access' });
    h.resolveModels({
      current: { provider: 'acp-kimi', model: 'kimi-default' },
      routable: true,
      groups: [
        { id: 'acp-kimi', name: 'Kimi · ACP', models: [{ id: 'kimi-default', name: 'Kimi' }] },
        { id: 'acp-codex', name: 'Codex · ACP', models: [{ id: 'codex-mini', name: 'Codex Mini' }] },
      ],
      failures: [],
    });
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    const store = createModelPickerStore().create(SESSION_ID);
    picker.attach(store.actions);

    await vi.waitFor(() => {
      expect(store.getSnapshot().directory.current).toEqual({ provider: 'acp-codex', model: 'codex-mini' });
    });
  });

  it('draft ACP 的 Full Access 尚未收敛时阻断 composer，权限投影确认后自动放行', async () => {
    const h = createHarness();
    const permission = Promise.withResolvers<{ ok: true; value: { matched: boolean } }>();
    const originalBinding = h.deps.sessions.binding;
    h.deps.sessions.binding = (sessionId) => {
      const binding = originalBinding(sessionId);
      if (binding === undefined) return undefined;
      return {
        session: {
          ...binding.session,
          command: (line) => {
            h.commandCalls.push({ sessionId, line });
            return permission.promise;
          },
        },
      };
    };
    h.deps.acpRemote = {
      ...h.deps.acpRemote,
      backendOf: () => Promise.resolve({ ok: true as const, value: { state: 'draft' as const, provider: 'acp-mock' } }),
    };
    h.setProjection({ currentValue: 'workspace-write' });
    h.resolveModels({ ...UNROUTABLE_VIEW, routable: true });

    const service = new PickerService(h.deps);
    await service.pickerFor(SESSION_ID).directory.load();
    await vi.waitFor(() => {
      expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: { reason: 'native.preparing' } });
    });

    permission.resolve({ ok: true, value: { matched: true } });
    h.setProjection({ currentValue: 'danger-full-access' });
    await vi.waitFor(() => {
      expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });
    });
  });
});

// ---------- continuity blocked 禁用 composer ----------

/** 宿主恒发的四个必填键（live 恒值形态；stale 形态见专项用例）。 */
const LIVE_WIRE_FIXED = {
  freshness: 'live',
  editable: true,
  fingerprintChanged: false,
  modelSwitch: { status: 'idle' },
} as const;

const CONTINUITY_BLOCKED_WIRE = {
  sessionId: SESSION_ID,
  configOptions: null,
  currentModeId: null,
  capabilities: null,
  contextUsage: null,
  continuity: { status: 'blocked', cause: 'reconciliation-required', detail: 'host restart dropped the live session' },
  ...LIVE_WIRE_FIXED,
};

const CONTINUITY_OK_WIRE = {
  ...CONTINUITY_BLOCKED_WIRE,
  continuity: { status: 'ok', cause: null, detail: null },
};

describe('PickerService composer block 的 continuity 分支', () => {
  function createContinuityHarness(queue: Array<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>) {
    const h = createHarness();
    h.deps.acpRemote = createFakeRemote(queue).remote;
    return h;
  }

  it('live 快照 blocked → 发布 blocked.continuity；rebind 归 ok 后解除', async () => {
    const h = createContinuityHarness([
      { ok: true, value: CONTINUITY_BLOCKED_WIRE },
      { ok: true, value: CONTINUITY_OK_WIRE },
    ]);
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    // 目录可路由（排除 blocked.composer 分支干扰），live 快照 blocked
    h.resolveModels({ ...UNROUTABLE_VIEW, routable: true });
    await picker.directory.load();
    await picker.live.load();
    expect(h.blocksLog.at(-1)).toEqual({
      sessionId: SESSION_ID,
      block: { reason: 'blocked.continuity' },
    });

    // rebindBlank 成功收敛（continuity 归 ok）→ live.subscribe → recompute → 解除 block
    await picker.live.rebind();
    expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });
  });

  it('routable=false 与 blocked 同时在场时 blocked.composer 分支优先', async () => {
    const h = createContinuityHarness([{ ok: true, value: CONTINUITY_BLOCKED_WIRE }]);
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    h.resolveModels(UNROUTABLE_VIEW);
    await picker.directory.load();
    await picker.live.load();
    expect(h.blocksLog.at(-1)).toEqual({
      sessionId: SESSION_ID,
      block: { reason: 'blocked.composer' },
    });
  });

  it('live 快照未加载（continuity 未知）时如实不阻断；scope 卸载后 live 退订不再发布', async () => {
    const h = createContinuityHarness([]);
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    h.resolveModels({ ...UNROUTABLE_VIEW, routable: true });
    await picker.directory.load();
    // live 从未加载（options 队列空）：无 continuity 事实 → 无 block
    expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });

    const callsBeforeDispose = (() => {
      (h.registrations[0]!.disposer as () => void)();
      return h.blocksLog.length;
    })();
    // live 订阅已退订 + active 闸：resetConnected 通知不再触发 block 发布
    picker.live.resetConnected();
    expect(h.blocksLog.length).toBe(callsBeforeDispose);
  });
});

// ----------：LiveOptionsController 旁路写路径（起经 dshAcp Remote） ----------

interface RemoteCall {
  method: 'options' | 'setOption' | 'rebindBlank';
  sessionId: string;
  request: unknown;
}

/**
 * 队列式 fake dshAcp remote：options/setOption 各消费一条应答，记录调用。
 * 应答形状即 RemoteResult：`{ok:true,value}` / `{ok:false,error:{message}}`。
 */
function createFakeRemote(queue: Array<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>) {
  const calls: RemoteCall[] = [];
  const consume = (method: RemoteCall['method'], sessionId: string, request?: unknown) => {
    calls.push({ method, sessionId, request });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected remote call (queue exhausted)');
    return Promise.resolve(next);
  };
  const remote: AcpRemoteLike = {
    health: () => Promise.reject(new Error('unexpected health')),
    options: (sessionId) => consume('options', sessionId) as Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>,
    setOption: (sessionId, request) => consume('setOption', sessionId, request) as Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>,
    backendOf: () => Promise.reject(new Error('unexpected backendOf')),
    rebindBlank: (sessionId) => consume('rebindBlank', sessionId) as Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>,
    boundSessions: () => Promise.reject(new Error('unexpected boundSessions')),
    beginModelSwitch: () => Promise.reject(new Error('unexpected beginModelSwitch')),
    commitModelSwitch: () => Promise.reject(new Error('unexpected commitModelSwitch')),
    rollbackModelSwitch: () => Promise.reject(new Error('unexpected rollbackModelSwitch')),
  };
  return { calls, remote };
}

const LIVE_WIRE_INITIAL = {
  sessionId: 'sess-1',
  configOptions: [
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: 'code',
      options: [
        { value: 'code', name: 'Code' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'm1',
      options: [
        { value: 'm1', name: 'M1' },
        { value: 'm2', name: 'M2' },
      ],
    },
    { type: 'boolean', id: 'fast', name: 'Fast', currentValue: false },
  ],
  currentModeId: 'code',
  capabilities: {
    loadSession: true,
    sessionList: true,
    sessionClose: false,
    sessionDelete: true,
    promptImage: true,
    promptAudio: false,
    promptEmbeddedContext: true,
    mcpHttp: false,
    mcpSse: false,
  },
  contextUsage: null,
  continuity: { status: 'ok', cause: null, detail: null },
  ...LIVE_WIRE_FIXED,
};

function createLiveHarness(queue: Array<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> = []) {
  const acpRemote = createFakeRemote(queue);
  const controller = new LiveOptionsController({
    sessionId: SESSION_ID,
    remote: acpRemote.remote,
  });
  return { controller, calls: acpRemote.calls };
}

describe('LiveOptionsController（旁路写路径， 经 dshAcp Remote）', () => {
  it('load() 采纳快照后零 setOption（agent 推送只刷新 UI 不回写）', async () => {
    const h = createLiveHarness([{ ok: true, value: LIVE_WIRE_INITIAL }]);
    await h.controller.load();
    const state = h.controller.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.snapshot?.configOptions?.map((option) => option.id)).toEqual(['mode', 'model', 'fast']);
    expect(state.snapshot?.currentModeId).toBe('code');
    // 恰好一次 options 读，无 setOption 写
    expect(h.calls).toEqual([{ method: 'options', sessionId: 'sess-1', request: undefined }]);
  });

  it('switchOption(select)：乐观应用 → setOption 原生 string 值 → 响应快照整体采纳，恰好 1 次写', async () => {
    // 响应快照模拟 agent 联动：mode 切 plan 的同时 model 被 agent 改为 m2
    const responseWire = {
      ...LIVE_WIRE_INITIAL,
      configOptions: [
        { ...LIVE_WIRE_INITIAL.configOptions[0], currentValue: 'plan' },
        { ...LIVE_WIRE_INITIAL.configOptions[1], currentValue: 'm2' },
        LIVE_WIRE_INITIAL.configOptions[2],
      ],
      currentModeId: 'plan',
    };
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_INITIAL },
      { ok: true, value: responseWire },
    ]);
    await h.controller.load();

    const pending = h.controller.switchOption('mode', 'plan');
    // 乐观应用：setOption 未回时私有态已变
    const optimistic = h.controller.getSnapshot();
    expect(optimistic.switching).toBe('mode');
    expect(optimistic.snapshot?.configOptions?.[0]).toMatchObject({ currentValue: 'plan' });
    expect(optimistic.snapshot?.currentModeId).toBe('plan');
    await pending;

    const state = h.controller.getSnapshot();
    expect(state.switching).toBeNull();
    expect(state.error).toBeNull();
    // 整体采纳响应快照（含 agent 联动的 model=m2），而非本地乐观值合并
    expect(state.snapshot?.configOptions?.map((option) => option.currentValue)).toEqual(['plan', 'm2', false]);
    expect(state.snapshot?.currentModeId).toBe('plan');
    // 全程恰好 1 options + 1 setOption（无循环回写）；request 原生 string 值
    expect(h.calls.map((call) => call.method)).toEqual(['options', 'setOption']);
    expect(h.calls[1]!.request).toEqual({ configId: 'mode', value: 'plan' });
  });

  it('attach 后 store 镜像跟随 glue：attach 即 resync，切换动作逐拍镜像', async () => {
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_INITIAL },
      {
        ok: true,
        value: {
          ...LIVE_WIRE_INITIAL,
          configOptions: [{ ...LIVE_WIRE_INITIAL.configOptions[0], currentValue: 'plan' }, ...LIVE_WIRE_INITIAL.configOptions.slice(1)],
          currentModeId: 'plan',
        },
      },
    ]);
    await h.controller.load();

    const store = createModelPickerStore().create(SESSION_ID);
    h.controller.attach(store.actions);
    // attach 即全量 resync：store 的 live slice 与 glue 权威态一致
    expect(store.getSnapshot().live).toEqual(h.controller.getSnapshot());

    await h.controller.switchOption('mode', 'plan');
    const mirrored = store.getSnapshot().live;
    expect(mirrored.switching).toBeNull();
    expect(mirrored.snapshot?.configOptions?.[0]).toMatchObject({ currentValue: 'plan' });
    expect(mirrored).toEqual(h.controller.getSnapshot());
  });

  it('switchOption(boolean)：request 是原生 boolean（类型保真，不是 "true" 字符串）', async () => {
    const responseWire = {
      ...LIVE_WIRE_INITIAL,
      configOptions: [
        LIVE_WIRE_INITIAL.configOptions[0],
        LIVE_WIRE_INITIAL.configOptions[1],
        { ...LIVE_WIRE_INITIAL.configOptions[2], currentValue: true },
      ],
    };
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_INITIAL },
      { ok: true, value: responseWire },
    ]);
    await h.controller.load();
    await h.controller.switchOption('fast', true);
    expect(h.calls[1]!.request).toEqual({ configId: 'fast', value: true });
    expect(h.controller.getSnapshot().snapshot?.configOptions?.[2]).toMatchObject({ currentValue: true });
  });

  it('setOption 失败回滚：snapshot 恢复切换前、error 落私有态、switching 清空', async () => {
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_INITIAL },
      { ok: false, error: { message: 'session is mid-turn' } },
    ]);
    await h.controller.load();
    const before = h.controller.getSnapshot().snapshot;
    await h.controller.switchOption('mode', 'plan');
    const state = h.controller.getSnapshot();
    expect(state.snapshot).toEqual(before);
    expect(state.switching).toBeNull();
    expect(state.error).toContain('session is mid-turn');
 // 文案分流：切换被拒（busy）标记为 switch 来源（UI 显示「切换未生效」而非加载失败）
    expect(state.errorSource).toBe('switch');
  });

  it('load 失败：error 落私有态且 errorSource=load（与切换被拒的文案分流互斥）', async () => {
    const h = createLiveHarness([
      { ok: false, error: { message: 'options backend down' } },
    ]);
    await h.controller.load();
    const state = h.controller.getSnapshot();
    expect(state.status).toBe('error');
    expect(state.error).toContain('options backend down');
    expect(state.errorSource).toBe('load');
    expect(state.snapshot).toBeNull();
  });

  it('model 类选项拒发：旁路不再写模型（零 setOption 调用，errorSource=switch）', async () => {
    const h = createLiveHarness([{ ok: true, value: LIVE_WIRE_INITIAL }]);
    await h.controller.load();
    await h.controller.switchOption('model', 'm2');
    const state = h.controller.getSnapshot();
    expect(state.errorSource).toBe('switch');
    expect(state.error).toBeTruthy();
    expect(h.calls.filter((call) => call.method === 'setOption')).toHaveLength(0);
    // 快照不被乐观应用污染：model 仍是 m1
    expect(state.snapshot?.configOptions?.[1]).toMatchObject({ currentValue: 'm1' });
  });

  it('stale 快照拒发：无活体时旁路写一律拒绝（零 setOption 调用）', async () => {
    const staleWire = { ...LIVE_WIRE_INITIAL, freshness: 'stale', editable: false };
    const h = createLiveHarness([{ ok: true, value: staleWire }]);
    await h.controller.load();
    await h.controller.switchOption('mode', 'plan');
    const state = h.controller.getSnapshot();
    expect(state.errorSource).toBe('switch');
    expect(state.error).toBeTruthy();
    expect(h.calls.filter((call) => call.method === 'setOption')).toHaveLength(0);
    expect(state.snapshot?.configOptions?.[0]).toMatchObject({ currentValue: 'code' });
  });

  it('切换期间（switching 非 null）忽略并发 switchOption（无第二次 setOption）', async () => {
    const responseWire = { ...LIVE_WIRE_INITIAL };
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_INITIAL },
      { ok: true, value: responseWire },
    ]);
    await h.controller.load();
    const first = h.controller.switchOption('mode', 'plan');
    // 第一次尚未完成：第二次调用直接 no-op
    await h.controller.switchOption('fast', true);
    await first;
    expect(h.calls.filter((call) => call.method === 'setOption')).toHaveLength(1);
  });

 // ---------- 收尾：rebindBlank 逃生门（reconciliation-required 的可执行出路） ----------

  const LIVE_WIRE_BLOCKED = {
    ...LIVE_WIRE_INITIAL,
    continuity: { status: 'blocked', cause: 'reconciliation-required', detail: 'host restart dropped the live session' },
  };

  it('rebind：continuity blocked 时调 rebindBlank，成功采纳响应快照（continuity 归 ok、rebinding 落 false）', async () => {
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_BLOCKED },
      { ok: true, value: LIVE_WIRE_INITIAL },
    ]);
    await h.controller.load();
    expect(h.controller.getSnapshot().snapshot?.continuity.status).toBe('blocked');

    await h.controller.rebind();
    const state = h.controller.getSnapshot();
    expect(h.calls).toEqual([
      { method: 'options', sessionId: 'sess-1', request: undefined },
      { method: 'rebindBlank', sessionId: 'sess-1', request: undefined },
    ]);
    expect(state.rebinding).toBe(false);
    expect(state.error).toBeNull();
    expect(state.errorSource).toBeNull();
    expect(state.snapshot?.continuity).toEqual({ status: 'ok', cause: null, detail: null });
  });

  it('rebind 失败：error 含 agent 消息、errorSource=rebind（与 load/switch 三分流），快照不动', async () => {
    const h = createLiveHarness([
      { ok: true, value: LIVE_WIRE_BLOCKED },
      { ok: false, error: { message: 'agent refused rebind' } },
    ]);
    await h.controller.load();
    const before = h.controller.getSnapshot().snapshot;
    await h.controller.rebind();
    const state = h.controller.getSnapshot();
    expect(state.rebinding).toBe(false);
    expect(state.error).toContain('agent refused rebind');
    expect(state.errorSource).toBe('rebind');
    expect(state.snapshot).toEqual(before);
  });

  it('rebind 守卫：continuity 非 blocked 时不发起 rebindBlank（no-op）', async () => {
    const h = createLiveHarness([{ ok: true, value: LIVE_WIRE_INITIAL }]);
    await h.controller.load();
    await h.controller.rebind();
    expect(h.calls.filter((call) => call.method === 'rebindBlank')).toHaveLength(0);
    expect(h.controller.getSnapshot().rebinding).toBe(false);
  });
});

// ----------：backendOf；：跨 backend 新会话事务 ----------

describe('PickerService backendOf / useInNewSession / takePendingNotice', () => {
  /**
   * 流程专用 harness：可写 settingsScope + 可控 settings.mutate + 可控
   * sessions.create + 工作区列表 fake。事务确认窗口收窄（20ms）保持测试快。
   * t 透传 key 与 params（提示文案断言用）。
   */
  function createFlowHarness(options: {
    mutateImpl?: () => Promise<{ result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } } }>;
    createImpl?: (input: { workspaceId?: string; cwd?: string; sessionId?: string }) => Promise<{
      result: { ok: true; value: { sessionId: string } } | { ok: false; error: { code: string; message: string } }
    }>;
    withWorkspaces?: boolean;
    workspaceItems?: Array<{ workspaceId: string; sessionIds: string[] }>;
    currentCwd?: string;
  } = {}) {
    const h = createHarness();
    const mutateCalls: unknown[] = [];
    const createCalls: Array<{ workspaceId?: string; cwd?: string; sessionId?: string }> = [];
    h.deps.settingsScope = {
      getSnapshot: () => ({ status: 'ready', value: undefined, revision: 7, writable: true }),
    };
    h.deps.transport.settings = {
      mutate: (request) => {
        mutateCalls.push(request);
        return (options.mutateImpl ?? (() => Promise.resolve({ result: { ok: true as const, value: { revision: 8 } } })))();
      },
    };
    h.deps.transport.sessions.create = (input) => {
      createCalls.push(input);
      return (options.createImpl ?? ((request) => {
        h.publishSessionRow(request.sessionId as string);
        return Promise.resolve({ result: { ok: true as const, value: { sessionId: request.sessionId as string } } });
      }))(input);
    };
    if (options.withWorkspaces !== false) {
      h.deps.workspaces = {
        list: {
          getSnapshot: () => ({
            items: options.workspaceItems ?? [{ workspaceId: 'ws-1', sessionIds: [SESSION_ID] }],
          }),
        },
      };
    }
    if (options.currentCwd !== undefined) h.publishSessionRow(SESSION_ID, { cwd: options.currentCwd });
    h.deps.listConfirmTimeoutMs = 20;
    const t: (key: string, params?: Record<string, string | number>) => string = (key, params) =>
      params === undefined ? key : `${key}:${JSON.stringify(params)}`;
    h.deps.t = t;
    return { ...h, mutateCalls, createCalls };
  }

  it('backendOf：应答解码透传；ok:false / 解码失败 / RPC 抛错一律归 null（「未知」降级）', async () => {
    const h = createFlowHarness();
    h.deps.acpRemote = {
      health: () => NEVER,
      options: () => NEVER,
      setOption: () => NEVER,
      backendOf: (sessionId) =>
        Promise.resolve({ ok: true as const, value: { state: 'established' as const, provider: `route-of-${sessionId}` } }),
      rebindBlank: () => NEVER,
      boundSessions: () => NEVER,
      beginModelSwitch: () => NEVER,
      commitModelSwitch: () => NEVER,
      rollbackModelSwitch: () => NEVER,
    };
    const service = new PickerService(h.deps);
    await expect(service.backendOf('sess-1')).resolves.toEqual({ state: 'established', provider: 'route-of-sess-1' });

    h.deps.acpRemote = { ...h.deps.acpRemote, backendOf: () => Promise.resolve({ ok: false as const, error: { message: 'boom' } }) };
    await expect(new PickerService(h.deps).backendOf('sess-1')).resolves.toBeNull();

    h.deps.acpRemote = { ...h.deps.acpRemote, backendOf: () => Promise.resolve({ ok: true as const, value: { state: 'weird' } as never }) };
    await expect(new PickerService(h.deps).backendOf('sess-1')).resolves.toBeNull();

    h.deps.acpRemote = { ...h.deps.acpRemote, backendOf: () => Promise.reject(new Error('connection reset')) };
    await expect(new PickerService(h.deps).backendOf('sess-1')).resolves.toBeNull();
  });

 it(' 取消确认：prepare 后丢弃 ticket（用户取消）——零写（默认模型不变、零 create、零 open）', () => {
    const h = createFlowHarness();
    const service = new PickerService(h.deps);
    const ticket = service.prepareCrossHandoff(SESSION_ID, { provider: 'acp-devin', model: 'devin-latest' }, 'Devin Latest');
    expect(ticket).toMatchObject({ sessionId: SESSION_ID, selection: { provider: 'acp-devin', model: 'devin-latest' } });
    // 用户取消：ticket 被丢弃，confirmCrossHandoff 永不运行
    expect(h.mutateCalls).toHaveLength(0);
    expect(h.createCalls).toHaveLength(0);
    expect(h.openCalls).toHaveLength(0);
    expect(service.takePendingNotice()).toBeNull();
  });

  it('成功次序：写 DSH 默认 → 公开 create → Full Access → open；目标保留为后续默认', async () => {
    const h = createFlowHarness();
    const order: string[] = [];
    h.deps.transport.settings = {
      mutate: (request) => {
        order.push('mutate');
        h.mutateCalls.push(request);
        return Promise.resolve({ result: { ok: true as const, value: { revision: 8 } } });
      },
    };
    const createInner = h.deps.transport.sessions.create;
    h.deps.transport.sessions.create = (input) => {
      order.push('create');
      return createInner(input);
    };
    const service = new PickerService(h.deps);
    const failure = await service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'devin-latest' }, 'Devin Latest');
    expect(failure).toBeUndefined();
    expect(order).toEqual(['mutate', 'create']);
    expect(h.mutateCalls).toEqual([{
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: 'acp-devin' },
        { op: 'set', path: ['model'], value: 'devin-latest' },
      ],
      expectedRevision: 7,
    }]);
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]!.workspaceId).toBe('ws-1');
    expect(h.createCalls[0]!.sessionId).toMatch(/^session-/);
    expect(h.commandCalls).toEqual([
      { sessionId: h.createCalls[0]!.sessionId, line: '/permission danger-full-access' },
    ]);
    // 导航到新建会话；旧会话全程未被触碰（open 只收新 id）
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
    expect(service.takePendingNotice()).toBe('cross.started:{"model":"Devin Latest"}');
    // 一次性：取走后即空
    expect(service.takePendingNotice()).toBeNull();
  });

  it('DSH 复用旧 native 空白页且当前默认是 ACP：自动创建真实 ACP 会话，不让首轮落入 ACP_STUB_ROUTE', async () => {
    const h = createFlowHarness();
    h.deps.acpRemote = {
      ...h.deps.acpRemote,
      backendOf: () => Promise.resolve({ ok: true as const, value: { state: 'blank' as const } }),
    };
    h.resolveModels({
      current: { provider: 'acp-codex', model: 'gpt-5.6-luna' },
      routable: true,
      groups: [{ id: 'acp-codex', name: 'Codex · ACP', models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' }] }],
      failures: [],
    });
    h.setCurrent(SESSION_ID);
    const service = new PickerService(h.deps);
    service.pickerFor(SESSION_ID);

    await vi.waitFor(() => { expect(h.createCalls).toHaveLength(1); });
    expect(h.commandCalls).toEqual([
      { sessionId: h.createCalls[0]!.sessionId, line: '/permission danger-full-access' },
    ]);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
    expect(h.blocksLog).toContainEqual({ sessionId: SESSION_ID, block: { reason: 'blank.preparing' } });
  });

  it('空白会话已有 native wrapper 时选择 ACP：自动创建并打开目标 DSH session，不伪装原地切换', async () => {
    const h = createFlowHarness();
    const fake = createFakeRemote([]);
    fake.remote.backendOf = () => Promise.resolve({ ok: true as const, value: { state: 'blank' as const } });
    h.deps.acpRemote = fake.remote;
    const selectModel = vi.fn(() => Promise.resolve({
      result: { ok: true as const, value: { selected: { provider: 'acp-devin', model: 'm' } } },
    }));
    h.deps.transport.sessions.selectModel = selectModel as never;
    h.resolveModels({
      current: { provider: 'deepseek', model: 'deepseek-chat' },
      routable: true,
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
      failures: [],
    });
    const service = new PickerService(h.deps);
    await service.pickerFor(SESSION_ID).directory.load();

    await expect(service.selectModel(SESSION_ID, { provider: 'acp-devin', model: 'm' }))
      .resolves.toBeUndefined();
    expect(selectModel).not.toHaveBeenCalled();
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
    expect(h.mutateCalls).toHaveLength(1);
    expect(h.commandCalls).toEqual([{ sessionId: h.createCalls[0]!.sessionId, line: '/permission danger-full-access' }]);
    expect(service.takePendingNotice()).toBe('cross.started:{"model":"m"}');
  });

  it('工作区解析回退：无所属工作区时使用当前会话 cwd；两者皆无则响亮报错', async () => {
    // cwd 直建（未分组会话）
    const h2 = createFlowHarness({ workspaceItems: [], currentCwd: '/current/project' });
    await expect(new PickerService(h2.deps).useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' })).resolves.toBeUndefined();
    expect(h2.createCalls[0]).toMatchObject({ cwd: '/current/project' });
    expect(h2.createCalls[0]).not.toHaveProperty('workspaceId');

    // 解析失败：请用户选择，绝不猜测目录——连默认模型都不写
    const h3 = createFlowHarness({ workspaceItems: [] });
    await expect(new PickerService(h3.deps).useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' })).resolves.toBe('cross.noWorkspace');
    expect(h3.mutateCalls).toHaveLength(0);
    expect(h3.createCalls).toHaveLength(0);
  });

  it('settingsScope 不可写时不创建：Alpha 无 create-time 模型参数，不能证明目标 backend', async () => {
    const h = createFlowHarness();
    h.deps.settingsScope = {
      getSnapshot: () => ({ status: 'idle', value: undefined, revision: 0, writable: false }),
    };
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'devin-latest' }))
      .resolves.toBe('cross.createFailed:{"message":"error.technical:{\\"reference\\":\\"\\"}"}');
    expect(h.createCalls).toHaveLength(0);
    expect(h.mutateCalls).toHaveLength(0);
  });

 it('workspaces 未接线 → 响亮报错且不写默认（工作区解析先于一切写）', async () => {
    const h = createFlowHarness({ withWorkspaces: false });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'devin-latest' })).resolves.toBe('cross.unavailable');
    expect(h.mutateCalls).toHaveLength(0);
    expect(h.createCalls).toHaveLength(0);
    expect(service.takePendingNotice()).toBeNull();
  });

  it('响应丢失但行已发布 → 经列表镜像采用该会话（恰好一次 create），照常 open', async () => {
    const h = createFlowHarness({
      createImpl: (input) => {
        // 宿主已发布会话（行同步入镜像），但响应在回程丢失
        h.publishSessionRow(input.sessionId as string);
        return Promise.reject(new Error('network lost'));
      },
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' }, 'M')).resolves.toBeUndefined();
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
    expect(service.takePendingNotice()).toBe('cross.started:{"model":"M"}');
  });

  it('响应丢失且行未发布 → 只用同一个 session id 重试（无重复创建），成功后 open', async () => {
    const h = createFlowHarness();
    let attempt = 0;
    h.deps.transport.sessions.create = (input) => {
      h.createCalls.push(input);
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('network lost'));
      h.publishSessionRow(input.sessionId as string);
      return Promise.resolve({ result: { ok: true as const, value: { sessionId: input.sessionId as string } } });
    };
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' })).resolves.toBeUndefined();
    expect(h.createCalls).toHaveLength(2);
    // 同一预分配 id、同一载荷——host 侧 ensureSession 对同 id 同 cwd 幂等
    expect(h.createCalls[1]).toEqual(h.createCalls[0]);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
  });

  it('连续两次响应丢失且列表仍无行 → 返回歧义结局，保留目标默认并提示检查列表', async () => {
    const h = createFlowHarness({
      createImpl: () => Promise.reject(new Error('network lost twice')),
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' }, 'M'))
      .resolves.toBe('cross.createAmbiguous:{"model":"M","message":"error.technical:{\\"reference\\":\\"\\"}"}');
    expect(h.createCalls).toHaveLength(2);
    expect(h.createCalls[1]).toEqual(h.createCalls[0]);
    expect(h.openCalls).toHaveLength(0);
    expect(h.mutateCalls).toHaveLength(1);
    expect(service.takePendingNotice()).toBeNull();
  });

  it('业务拒绝（非 attach-failed）→ 不重试、不 open，报错带宿主消息', async () => {
    const h = createFlowHarness({
      createImpl: () => Promise.resolve({ result: { ok: false as const, error: { code: 'internal', message: 'host exploded' } } }),
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' }))
      .resolves.toBe('cross.createFailedRestored:{"message":"error.technical:{\\"reference\\":\\"\\"}"}');
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toHaveLength(0);
    expect(h.mutateCalls).toHaveLength(2);
    expect(h.mutateCalls[1]).toEqual({
      ns: 'agent-default-model',
      ops: [
        { op: 'unset', path: ['provider'] },
        { op: 'unset', path: ['model'] },
      ],
      expectedRevision: 8,
    });
  });

  it('Alpha SessionCreateError.rpcError 业务拒绝 → 不当作传输歧义、不重试', async () => {
    const h = createFlowHarness({
      createImpl: () => Promise.reject(Object.assign(new Error('session create failed'), {
        rpcError: { code: 'internal', message: 'host exploded' },
      })),
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' }))
      .resolves.toBe('cross.createFailedRestored:{"message":"error.technical:{\\"reference\\":\\"\\"}"}');
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toHaveLength(0);
  });

  it('workspace-attach-failed：会话已发布但未分组——打开该未分组会话 + 明确提示，绝不创建第二个', async () => {
    const h = createFlowHarness({
      createImpl: (input) => {
        h.publishSessionRow(input.sessionId as string);
        return Promise.resolve({
          result: { ok: false as const, error: { code: 'workspace-attach-failed', message: 'registry write failed' } },
        });
      },
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' }, 'M')).resolves.toBeUndefined();
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
    expect(service.takePendingNotice()).toBe('cross.attachFailed:{"model":"M","message":"error.technical:{\\"reference\\":\\"\\"}"}');
  });

  it('Alpha SessionCreateError.rpcError=workspace-attach-failed：等待镜像行后打开未分组会话', async () => {
    const h = createFlowHarness({
      createImpl: (input) => {
        // Alpha throws after publishing the session, before the workspace
        // registry refresh reaches the client.  The attach-failure branch is
        // therefore the only create path that still needs bounded observation.
        h.publishSessionRow(input.sessionId as string);
        return Promise.reject(Object.assign(new Error('workspace attach failed'), {
          rpcError: { code: 'workspace-attach-failed', message: 'registry write failed' },
        }));
      },
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' }, 'M')).resolves.toBeUndefined();
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
    expect(service.takePendingNotice()).toBe('cross.attachFailed:{"model":"M","message":"error.technical:{\\"reference\\":\\"\\"}"}');
  });

  it('Alpha create 成功即完成 list/binding 发布 → 不等待列表轮询，直接 open', async () => {
    const h = createFlowHarness({
      createImpl: (input) => Promise.resolve({ result: { ok: true as const, value: { sessionId: input.sessionId as string } } }),
    });
    const service = new PickerService(h.deps);
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' })).resolves.toBeUndefined();
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
  });

  it('双击/快速重复选择：在飞闩锁下恰好产生一个会话（create 恰好一次，第二次归 cross.inflight）', async () => {
    const h = createFlowHarness();
    let release: (() => void) | undefined;
    h.deps.transport.sessions.create = (input) => {
      h.createCalls.push(input);
      return new Promise((resolve) => {
        release = () => {
          h.publishSessionRow(input.sessionId as string);
          resolve({ result: { ok: true as const, value: { sessionId: input.sessionId as string } } });
        };
      });
    };
    const service = new PickerService(h.deps);
    const first = service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' });
    // 第一笔在飞（create 未回）：第二次点击立即被闩锁拒绝
    await expect(service.useInNewSession(SESSION_ID, { provider: 'acp-devin', model: 'm' })).resolves.toBe('cross.inflight');
    release!();
    await expect(first).resolves.toBeUndefined();
    expect(h.createCalls).toHaveLength(1);
    expect(h.openCalls).toEqual([h.createCalls[0]!.sessionId]);
  });
});

// ----------：composer block 的 modelSwitch 分支 + selectModel 统一路由 ----------

/** modelSwitch 视图的 wire 变体（CONTINUITY_OK_WIRE 的 continuity 恒 ok，隔离变量）。 */
function switchWire(modelSwitch: unknown, freshness: 'live' | 'stale' = 'live', editable = true) {
  return { ...CONTINUITY_OK_WIRE, freshness, editable, modelSwitch };
}

const PENDING_VIEW = {
  status: 'pending',
  operationId: 'op-1',
  state: 'agent-applied',
  provider: 'acp-mock',
  optionId: 'model',
  previousModel: 'm1',
  targetModel: 'm2',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('PickerService composer block 的 modelSwitch 分支', () => {
  async function loadWithWire(wire: unknown) {
    const h = createHarness();
    // 两份相同应答：prime 的预拉与本用例的显式 load 各消费一份
    h.deps.acpRemote = createFakeRemote([{ ok: true, value: wire }, { ok: true, value: wire }]).remote;
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    h.resolveModels({ ...UNROUTABLE_VIEW, routable: true });
    await picker.directory.load();
    await picker.live.load();
    return h;
  }

  it('rollback-required / corrupt：恒阻断（live 与 stale 同罚——一致性无法自证）', async () => {
    const locked = { status: 'rollback-required', operationId: 'op-1', provider: 'acp-mock', previousModel: 'm1', targetModel: 'm2' };
    expect((await loadWithWire(switchWire(locked))).blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: { reason: 'blocked.modelSwitch' } });
    expect((await loadWithWire(switchWire(locked, 'stale', false))).blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: { reason: 'blocked.modelSwitch' } });
    expect((await loadWithWire(switchWire({ status: 'corrupt' }, 'stale', false))).blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: { reason: 'blocked.modelSwitch' } });
  });

  it('pending：live 会话阻断（恢复器 converge 前不放行 prompt）；stale 不阻断（无活体可写，resume 后收敛）', async () => {
    expect((await loadWithWire(switchWire(PENDING_VIEW))).blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: { reason: 'blocked.modelSwitch' } });
    expect((await loadWithWire(switchWire(PENDING_VIEW, 'stale', false))).blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: undefined });
  });

  it('routable=false 优先于 modelSwitch 分支', async () => {
    const h = createHarness();
    h.deps.acpRemote = createFakeRemote([{ ok: true, value: switchWire(PENDING_VIEW) }]).remote;
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    h.resolveModels(UNROUTABLE_VIEW);
    await picker.directory.load();
    await picker.live.load();
    expect(h.blocksLog.at(-1)).toEqual({ sessionId: SESSION_ID, block: { reason: 'blocked.composer' } });
  });
});

describe('PickerService.selectModel 统一路由（同 provider ACP → coordinator；其余 → 目录选择）', () => {
  const ROUTABLE_ACP_VIEW: SessionModelsView = {
    current: { provider: 'acp-mock', model: 'm1' },
    routable: true,
    groups: [{ id: 'acp-mock', name: 'Mock · ACP', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }],
    failures: [],
  };

  function liveIdleWire(modelValue = 'm1') {
    return {
      sessionId: SESSION_ID,
      configOptions: [
        {
          type: 'select',
          id: 'model',
          category: 'model',
          name: 'Model',
          currentValue: modelValue,
          options: [
            { value: 'm1', name: 'M1' },
            { value: 'm2', name: 'M2' },
          ],
        },
      ],
      currentModeId: 'code',
      capabilities: null,
      continuity: { status: 'ok', cause: null, detail: null },
      contextUsage: null,
      ...LIVE_WIRE_FIXED,
    };
  }

  function createRoutingHarness() {
    const h = createHarness();
    const fr = createFakeRemote([{ ok: true, value: liveIdleWire() }, { ok: true, value: liveIdleWire() }, { ok: true, value: liveIdleWire('m2') }]);
    const beginModelSwitch = vi.fn((_sessionId: string, request: { operationId: string; targetModel: string }) =>
      Promise.resolve({ ok: true as const, value: { actualModel: request.targetModel, snapshot: liveIdleWire(request.targetModel) } }),
    );
    const commitModelSwitch = vi.fn(() => Promise.resolve({ ok: true as const, value: liveIdleWire('m2') }));
    const rollbackModelSwitch = vi.fn(() => Promise.resolve({ ok: true as const, value: liveIdleWire() }));
    fr.remote.beginModelSwitch = beginModelSwitch as never;
    fr.remote.commitModelSwitch = commitModelSwitch as never;
    fr.remote.rollbackModelSwitch = rollbackModelSwitch as never;
    fr.remote.backendOf = () => Promise.resolve({
      ok: true as const,
      value: { state: 'established' as const, provider: 'acp-mock' },
    });
    const selectModel = vi.fn((input: { sessionId: string; provider: string; model: string }) =>
      Promise.resolve({ result: { ok: true as const, value: { selected: { provider: input.provider, model: input.model } } } }),
    );
    h.deps.transport.sessions.selectModel = selectModel as never;
    h.deps.acpRemote = fr.remote;
    return { ...h, beginModelSwitch, commitModelSwitch, rollbackModelSwitch, selectModel };
  }

  it('同 provider ACP 选择 → coordinator 持久事务（begin/commit 被调，sessions.selectModel 收 actualModel）', async () => {
    const h = createRoutingHarness();
    const service = new PickerService(h.deps);
    h.resolveModels(ROUTABLE_ACP_VIEW);
    const picker = service.pickerFor(SESSION_ID);
    await picker.directory.load();
    await picker.live.load();
    await service.selectModel(SESSION_ID, { provider: 'acp-mock', model: 'm2' });
    expect(h.beginModelSwitch).toHaveBeenCalledTimes(1);
    expect(h.beginModelSwitch.mock.calls[0]?.[1]).toMatchObject({ targetModel: 'm2' });
    expect(h.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: 'acp-mock', model: 'm2' });
    expect(h.commitModelSwitch).toHaveBeenCalledTimes(1);
  });

  it('异 provider / 异 ACP profile 选择 → service 纵深拒绝，必须走确认后新会话', async () => {
    const h = createRoutingHarness();
    const service = new PickerService(h.deps);
    h.resolveModels(ROUTABLE_ACP_VIEW);
    const picker = service.pickerFor(SESSION_ID);
    await picker.directory.load();
    await expect(service.selectModel(SESSION_ID, { provider: 'acp-other', model: 'm9' }))
      .rejects.toThrow('requires confirmation and a new session');
    expect(h.selectModel).not.toHaveBeenCalled();
    expect(h.beginModelSwitch).not.toHaveBeenCalled();
    expect(h.commitModelSwitch).not.toHaveBeenCalled();
  });

  it('coordinator 失败 → selectModel 抛出同源消息（目录 select 文案位已落错误）', async () => {
    const h = createRoutingHarness();
    h.beginModelSwitch.mockResolvedValueOnce({ ok: false, error: { message: 'agent rejected the model' } } as never);
    const service = new PickerService(h.deps);
    h.resolveModels(ROUTABLE_ACP_VIEW);
    const picker = service.pickerFor(SESSION_ID);
    await picker.directory.load();
    await picker.live.load();
    await expect(service.selectModel(SESSION_ID, { provider: 'acp-mock', model: 'm2' })).rejects.toThrow('agent rejected the model');
    expect(h.selectModel).not.toHaveBeenCalled();
  });
});

// ----------：失败降级矩阵（native-only / 坏 profile / 非 ACP 不触 coordinator） ----------

describe(' 失败降级：backendProbe 三值 + native 路径免疫', () => {
  const NATIVE_VIEW: SessionModelsView = {
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true,
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      },
    ],
    failures: [],
  };

  /** 全方法记录的 acpRemote fake：backendOf 行为可注入，其余方法调用即记。 */
  function recordingRemote(
    backendOf: () => Promise<AcpRemoteResultLike<never>>,
    options: () => Promise<AcpRemoteResultLike<never>> = () => Promise.reject(new Error('options backend down')),
  ) {
    const calls: string[] = [];
    const record = (name: string) => { calls.push(name); };
    const remote: AcpRemoteLike = {
      health: () => { record('health'); return NEVER; },
      options: () => { record('options'); return options(); },
      setOption: () => { record('setOption'); return NEVER; },
      backendOf: () => { record('backendOf'); return backendOf(); },
      rebindBlank: () => { record('rebindBlank'); return NEVER; },
      boundSessions: () => { record('boundSessions'); return NEVER; },
      beginModelSwitch: () => { record('beginModelSwitch'); return NEVER; },
      commitModelSwitch: () => { record('commitModelSwitch'); return NEVER; },
      rollbackModelSwitch: () => { record('rollbackModelSwitch'); return NEVER; },
    };
    return { calls, remote };
  }

  it.each([
    ['Remote 拒绝（超时/连接失败）', () => Promise.reject(new Error('connect ETIMEDOUT'))],
    ['Remote 错误分支（404/协议错误）', () => Promise.resolve({ ok: false as const, error: { message: 'not found: no such route (404)' } })],
    ['非法载荷（decode 整包拒）', () => Promise.resolve({ ok: true as const, value: { state: 'weird' } as never })],
  ])('backendProbe：%s → unavailable 点名消息；backendOf 兼容读面归 null', async (_label, backendOf) => {
    const h = createHarness();
    const fake = recordingRemote(backendOf);
    h.deps.acpRemote = fake.remote;
    const service = new PickerService(h.deps);

    const probe = await service.backendProbe(SESSION_ID);
    expect(probe.status).toBe('unavailable');
    if (probe.status === 'unavailable') expect(probe.message.length).toBeGreaterThan(0);
    // 兼容读面（popup 标记/dock 统计行）照旧按「未知」降级，不抛不标记
    await expect(service.backendOf(SESSION_ID)).resolves.toBeNull();
  });

  it.each([
    ['blank', { state: 'blank' }, { state: 'blank' }],
    ['established ACP', { state: 'established', provider: 'acp-devin' }, { state: 'established', provider: 'acp-devin' }],
  ])('backendProbe：合法应答 %s → ok 原样透传', async (_label, wire, expected) => {
    const h = createHarness();
    const fake = recordingRemote(() => Promise.resolve({ ok: true, value: wire as never }));
    h.deps.acpRemote = fake.remote;
    const service = new PickerService(h.deps);
    await expect(service.backendProbe(SESSION_ID)).resolves.toEqual({ status: 'ok', state: expected });
    await expect(service.backendOf(SESSION_ID)).resolves.toEqual(expected);
  });

  it('Remote/sidecar 不可用 + live 加载失败时，native 模型选择仍走目录旧路径落地', async () => {
    const h = createHarness();
    const fake = recordingRemote(() => Promise.reject(new Error('sidecar unavailable: database is locked')));
    h.deps.acpRemote = fake.remote;
    const selectCalls: unknown[] = [];
    h.deps.transport.sessions.selectModel = (input) => {
      selectCalls.push(input);
      return Promise.resolve({ result: { ok: true as const, value: { selected: { provider: input.provider, model: input.model } } } });
    };
    h.resolveModels(NATIVE_VIEW);
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);

    // live 通道失败（sidecar/Remote 不可用）——只落 live slice 错误态
    await picker.live.load();
    expect(picker.live.getSnapshot().status).toBe('error');
    // backend 探测 unavailable（seat 据此进 native-only；此处钉 glue 面）
    expect((await service.backendProbe(SESSION_ID)).status).toBe('unavailable');

    // native 选择照常落地（目录 select-then-adopt 旧路径，零 ACP 依赖）
    await picker.directory.load();
    await service.selectModel(SESSION_ID, { provider: 'deepseek', model: 'deepseek-reasoner' });
    expect(selectCalls).toEqual([{ sessionId: SESSION_ID, provider: 'deepseek', model: 'deepseek-reasoner' }]);
    expect(picker.directory.getSnapshot().current).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' });
    // 切换协调器的方法从未被调用（begin/commit/rollback 零记录）
    expect(fake.calls.filter((call) => call !== 'backendOf' && call !== 'options')).toEqual([]);
  });

  it('非 ACP 会话全程不加载/调用 switch coordinator：prime 无 options 预拉，selectModel 无 beginModelSwitch', async () => {
    const h = createHarness();
    const fake = recordingRemote(() => Promise.resolve({ ok: true, value: { state: 'blank' } as never }));
    h.deps.acpRemote = fake.remote;
    h.deps.transport.sessions.selectModel = (input) =>
      Promise.resolve({ result: { ok: true as const, value: { selected: { provider: input.provider, model: input.model } } } });
    h.resolveModels(NATIVE_VIEW);
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    // prime 的目录预拉落地（native current）——不应触发 live 预拉
    await picker.directory.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls).toEqual(['backendOf']);
    // native 选择：不触碰协调器（native provider 永不满足 sameProviderAcp 分流）
    await service.selectModel(SESSION_ID, { provider: 'deepseek', model: 'deepseek-reasoner' });
    expect(fake.calls).toEqual(['backendOf', 'backendOf']);
    expect(fake.calls.some((call) => call.startsWith('beginModelSwitch') || call.startsWith('commitModelSwitch') || call.startsWith('rollbackModelSwitch'))).toBe(false);
  });

  it('一个损坏/失败的 ACP profile 保留诊断事实，但 /model 只展示可用模型', async () => {
    const h = createHarness();
    // 目录 wire 应答：native 组完好 + acp-devin 组探测失败（host buildModelCatalog
    // 同款失败隔离的 client 侧消费面）
    h.resolveModels({
      ...NATIVE_VIEW,
      failures: [{ id: 'acp-devin', name: 'Devin · ACP', message: 'probe failed: profile config is corrupt' }],
    });
    const service = new PickerService(h.deps);
    const picker = service.pickerFor(SESSION_ID);
    await picker.directory.load();
    const state = picker.directory.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.failures.map((failure) => failure.id)).toEqual(['acp-devin']);
    // /model popup 行构建（src/client/index.ts 入口 1 的等价路径）：native 行
    // 可选（active/selectable），ACP 失败行不在 picker 重复展示。
    const { optionsOf, selectionOf } = await import('../../../src/client/host-compat/model-picker/popup.ts');
    const t = ((key: string) => key) as never;
    const rows = optionsOf({
      current: state.current!,
      routable: state.routable ?? false,
      groups: [...state.groups],
      failures: [...state.failures],
    }, t);
    expect(rows.some((row) => row.id === 'deepseek/deepseek-reasoner' && row.active === undefined)).toBe(true);
    const failureRow = rows.find((row) => row.id === 'failure/acp-devin');
    expect(failureRow).toBeUndefined();
    expect(selectionOf(state, 'deepseek/deepseek-reasoner')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' });
    expect(selectionOf(state, 'failure/acp-devin')).toBeUndefined();
  });
});
