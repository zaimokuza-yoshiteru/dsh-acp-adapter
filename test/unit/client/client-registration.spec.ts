// client-registration.spec.ts — 注册纪律钉：client 入口（src/client/index.ts）
// 的 slot/store 注册形态与卸载残留； 增补 per-contribution 隔离钉。
//
// fake ctx 严格按 cordis 语义立即执行 effect 本体、收集其返回的 disposer；
// slots.inject 走「槽声明已在场」路径（回调同步执行）；slots.register 捕获注册
// entry。ctx.inject 的子 fiber 语义按 cordis fiber.ts 启动失败路径仿真：
// scope 回调 throw 只 dispose 该 scope，不传染父 fiber 与兄弟 scope。
// 断言分两组：
//   注册形态：两个带 store 的 seat 都声明独占 store 工厂（模块级零 handle——连调
//     两次必须产出不同 handle）；注入工厂收到烘焙 actions 即 attach glue（面板
//     store 被 resync 到 scope 投影；picker store 三 slice 一次灌入）；/model
// 命令注册在独立 scope； 的 dock 统计行（conversation.composer.dock）
// 是无 store/inject 的 list 槽 entry；toolview 渲染器
//     （tool.call.toolview，key = 稳定名 dsh_acp_external_tool）是纯渲染贡献
//     （只按 sessionId 注入有界运行态展示查询，不注册假可执行工具）。
//   卸载残留：跑完全部 fiber disposer 后——两个 locale 命名空间退订、controller
//     dispose（scope 退订、sink 断开）、pickerService dispose（remote 两路 +
//     connection/reset 退订）、commandUi 贡献撤下、六个 slot 注册 disposer 被调。
//   per-session picker 清理骑 session fiber（非本插件 fiber），其钉在
//   picker-service.spec.ts。
// 隔离：每个贡献（settings.section / /model 命令 / conversation.input.model
//     seat / composer dock / permission dock / elicitation dock / toolview）占独立 inject scope——可选 ACP 子模块
//     （dock/toolview/seat）注册失败不撤销 picker 核心贡献与兄弟贡献；
//     pickerService 装配失败只禁用 picker 族，设置面板存活（fail closed 点名）。

import { describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../../../src/client/index.ts';
import type { StoreHandle, StoreInstance } from '@deepseek-ai/dsh-client-store';
import type { SessionModelsView } from '../../../src/client/data/selector-logic.ts';

// ---------- fake ctx ----------

interface RegisteredEntry {
  name: string
  store?: (() => StoreHandle<never, never>) | undefined
  inject?: (...args: unknown[]) => Record<string, unknown>
  [key: string]: unknown
}

function createFakeCtx(options: {
  failOnRegister?: string
  failOnRegisterId?: string
  failRemoteOn?: boolean
  models?: SessionModelsView
  remoteReady?: boolean
  backendOf?: unknown
  nestedRemoteResult?: boolean
} = {}) {
  const effectDisposers: Array<{ name: string | undefined; run: () => void }> = [];
  const localeUnregisters: Array<{ ns: string; dispose: () => void }> = [];
  const slotInjectDisposers: Array<{ name: string; dispose: () => void }> = [];
  const commandDisposers: Array<() => void> = [];
  const remoteUnsubs: Array<{ name: string; dispose: () => void }> = [];
  const connectionResetUnsubs: Array<() => void> = [];
  const scopeUnsub = vi.fn();
  let scopeListener: (() => void) | undefined;
  const registeredEntries: RegisteredEntry[] = [];
  const commandEntries: unknown[] = [];
  const selectCalls: unknown[] = [];

  const scopeLike = {
    getSnapshot: () => ({ status: 'ready' as const, value: { agents: {} }, revision: 1, writable: true }),
    subscribe(listener: () => void) {
      scopeListener = listener;
      return scopeUnsub;
    },
  };

  const slots = {
    inject(name: string, contribute: () => unknown) {
      const disposer = contribute();
      const dispose = () => {
        if (typeof disposer === 'function') (disposer as () => void)();
      };
      slotInjectDisposers.push({ name, dispose });
      return dispose;
    },
    register(entry: RegisteredEntry, _component: unknown) {
 // 隔离钉的故障注入点：指定槽位的 register 抛错（槽结构漂移等价物）。
      if (
        (options.failOnRegister !== undefined && entry.name === options.failOnRegister)
        || (options.failOnRegisterId !== undefined && entry.id === options.failOnRegisterId)
      ) {
        throw new Error(`simulated slot registration failure: ${entry.name}`);
      }
      registeredEntries.push(entry);
      return () => {};
    },
  };

  const ctx = {
    get(name: string): unknown {
      switch (name) {
        case 'locale':
          return {
            register(ns: string, _dicts: unknown) {
              const dispose = vi.fn();
              localeUnregisters.push({ ns, dispose });
              return dispose;
            },
            bind: () => (key: string) => key,
          };
        case 'connection':
          return {
            api: {
              settings: {
                mutate: () => Promise.resolve({ result: { ok: true as const, value: {} } }),
              },
              sessions: {
                models: () => options.models === undefined
                  ? new Promise<never>(() => {})
                  : Promise.resolve({ result: { ok: true as const, value: options.models } }),
                selectModel: (request: unknown) => {
                  selectCalls.push(request);
                  const selection = request as { provider: string; model: string; reasoningEffort?: string };
                  return Promise.resolve({
                    result: {
                      ok: true as const,
                      value: {
                        selected: {
                          provider: selection.provider,
                          model: selection.model,
                          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                        },
                      },
                    },
                  });
                },
              },
            },
          };
        case 'settingsScope':
          return { bind: () => scopeLike };
        case 'slots':
          return slots;
        case 'remote':
          return {
            $on(name: string, _listener: unknown) {
 // 故障注入：pickerService 装配期 remote.$on 抛错（宿主面漂移）。
              if (options.failRemoteOn === true) throw new Error('simulated remote.$on failure');
              const dispose = vi.fn();
              remoteUnsubs.push({ name, dispose });
              return dispose;
            },
 // 大多数注册形态测试让 namespace 永挂起；命令路径测试
            // 显式打开 mounted namespace，才能真实走 backendProbe 分流。
            $mount: () => options.remoteReady === true ? Promise.resolve({}) : new Promise<never>(() => {}),
          };
        case 'remote.session':
          return {
            modelCatalog: () => {
              const result = options.models === undefined
                ? new Promise<never>(() => {})
                : Promise.resolve({
                ok: true as const,
                value: {
                  default: options.models.current,
                  routableProviders: options.models.routable ? [options.models.current.provider] : [],
                  groups: options.models.groups,
                  failures: options.models.failures,
                },
                });
              return options.nestedRemoteResult === true
                ? result.then((value) => ({ result: value }))
                : result;
            },
            selectModel: (request: unknown) => {
              selectCalls.push(request);
              const selection = request as { provider: string; model: string; reasoningEffort?: string };
              return Promise.resolve({
                ok: true as const,
                value: {
                  selected: {
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                  },
                },
              });
            },
          };
        case 'remote.settings':
          return {
            mutate: () => Promise.resolve({ ok: true as const, value: {} }),
          };
        case 'remote.dshAcp':
          return {
            health: () => Promise.resolve({ ok: true, value: {} }),
            options: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
            setOption: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
            backendOf: () => options.backendOf ?? { ok: false, error: { message: 'ACP unavailable' } },
            rebindBlank: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
            toolPresentation: () => Promise.resolve({ ok: true, value: null }),
            boundSessions: () => Promise.resolve({ ok: true, value: { count: 0 } }),
            beginModelSwitch: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
            commitModelSwitch: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
            rollbackModelSwitch: () => Promise.resolve({ ok: false, error: { message: 'unused' } }),
          };
        case 'commandUi':
          return {
            register(entry: unknown) {
              commandEntries.push(entry);
              const dispose = vi.fn();
              commandDisposers.push(dispose);
              return dispose;
            },
          };
        case 'sessions':
          return {
            subagentAddress: () => undefined,
            create: (input: { sessionId?: string }) => Promise.resolve(input.sessionId ?? 'created-session'),
            scope: () => ({
              effect(fn: () => () => void, _name?: string) {
                fn();
                return () => {};
              },
            }),
            binding: () => undefined,
 // 新会话事务的列表确认/导航面（本文件不触发事务，仅形态钉）。
            list: { getSnapshot: () => ({ byId: {}, current: undefined }), subscribe: () => () => {} },
            open: () => {},
          };
        case 'workspaces':
 // 跨 backend 分流的工作区解析面（公开 IWorkspaces.list 观察面）；
          // 本文件只钉注册形态，不触发 useInNewSession。
          return { list: { getSnapshot: () => ({ items: [], recentWorkspaceId: undefined }) } };
        case 'conversation':
          return undefined;
        default:
          throw new Error(`unexpected ctx.get('${name}')`);
      }
    },
    effect(fn: () => () => void, name?: string) {
      const run = fn();
      effectDisposers.push({ name, run });
      return run;
    },
    inject(_names: string[], callback: (scope: unknown) => void) {
      // cordis 子 fiber 语义（fiber.ts 启动失败路径）：scope 回调 throw 只
 // dispose 该子 fiber，父 fiber 与兄弟 scope 的贡献不受影响—— 的
      // per-contribution 隔离钉依赖这个仿真。
      try {
        callback(ctx);
      } catch {
        /* isolated child fiber failure */
      }
    },
    on(name: string, _listener: () => void) {
      const dispose = vi.fn();
      if (name === 'connection/reset') connectionResetUnsubs.push(dispose);
      return dispose;
    },
  };

  return {
    ctx,
    registeredEntries,
    effectDisposers,
    localeUnregisters,
    slotInjectDisposers,
    commandDisposers,
    commandEntries,
    selectCalls,
    remoteUnsubs,
    connectionResetUnsubs,
    scopeUnsub,
    notifyScope() {
      scopeListener?.();
    },
  };
}

// ---------- 测试 ----------

describe('client 入口注册形态（slot/store 纪律）', () => {
  it('declares the Alpha Generated Remote namespaces explicitly', () => {
    expect(inject).toContain('remote.session');
    expect(inject).toContain('remote.settings');
    expect(inject).not.toContain('connection');
  });

  it('两个 seat 都声明独占 store 工厂（模块级零 handle）；注入工厂 attach glue', () => {
    const h = createFakeCtx();
    apply(h.ctx as never);

    expect(h.registeredEntries).toHaveLength(8);
    const [section, auditHeader, picker, recoveryDock, dock, permissionDock, elicitationDock, toolview] = h.registeredEntries as [RegisteredEntry, RegisteredEntry, RegisteredEntry, RegisteredEntry, RegisteredEntry, RegisteredEntry, RegisteredEntry, RegisteredEntry];

    expect(section.name).toBe('settings.section');
    expect(auditHeader.name).toBe('conversation.session.header.utilities');
    expect(picker.name).toBe('conversation.input.model');
 // ACP context 统计行进 composer dock（list 槽；宿主 stats(0) 之后，无 store/inject seat）
    expect(recoveryDock.id).toBe('acp-recovery');
    expect(dock.name).toBe('conversation.composer.dock');
    expect(dock.id).toBe('acp-context-usage');
    expect(dock.order).toBe(1);
    expect(dock.store).toBeUndefined();
    expect(dock.inject).toBeUndefined();

    expect(permissionDock.name).toBe('conversation.input.dock');
    expect(permissionDock.id).toBe('acp-permissions');
    expect(permissionDock.order).toBe(-10);
    expect(permissionDock.locale).toBe('settings.acp');

    expect(elicitationDock.name).toBe('conversation.input.dock');
    expect(elicitationDock.id).toBe('acp-elicitations');
    expect(elicitationDock.order).toBe(-9);
    expect(elicitationDock.locale).toBe('settings.acp');

 // keyed toolview 渲染器——key 是稳定 wire name，locale 挂
 // 'acp-model' 命名空间；inject 只闭包当前 session 的有界展示查询。
    expect(toolview.name).toBe('tool.call.toolview');
    expect(toolview.key).toBe('dsh_acp_external_tool');
    expect(toolview.locale).toBe('acp-model');
    expect(toolview.store).toBeUndefined();
    expect(typeof toolview.inject).toBe('function');
    const toolFace = toolview.inject!('session-tool') as { loadPresentation: (callId: string) => Promise<unknown> };
    expect(typeof toolFace.loadPresentation).toBe('function');

    // 独占工厂形态：store 位是函数，连调产出不同 handle（共享 handle 会被
    // 模块缓存伪装成跨重载单例——register 的 store 位只接受工厂或共享 handle，
    // 本插件一律传工厂）。
    for (const entry of [section, picker]) {
      expect(typeof entry.store).toBe('function');
      const first = entry.store!();
      const second = entry.store!();
      expect(first).not.toBe(second);
    }

    // settings.section 注入工厂：收到烘焙 actions → attach → store resync 到 scope 投影。
    const panelStore = section.store!().create() as StoreInstance<{
      settings: { status: string };
    }, never>;
    const sectionFace = section.inject!(panelStore.actions);
    expect(typeof (sectionFace['panel'] as Record<string, unknown>)['refreshHealth']).toBe('function');
    expect(typeof (sectionFace['panel'] as Record<string, unknown>)['refreshAgentHealth']).toBe('function');
    expect(panelStore.getSnapshot().settings.status).toBe('ready');

    // conversation.input.model 注入工厂（session+store 形态：(sessionId, actions)）。
    const pickerStore = picker.store!().create('sess-1') as StoreInstance<{
      backendAccess: { provider: string; preset: string | undefined };
    }, never>;
    const pickerFace = picker.inject!('sess-1', pickerStore.actions);
    expect(pickerFace['available']).toBe(true);
    expect(typeof (pickerFace['picker'] as Record<string, unknown>)['select']).toBe('function');
    // attach immediately resyncs backend access (no binding means provider '' and unknown preset).
    expect(pickerStore.getSnapshot().backendAccess).toEqual({ provider: '', preset: undefined });
    // 插件不再添加独立“设为默认”动作，也不向 seat 注入默认模型观察面。
    expect(pickerFace).not.toHaveProperty('hooks');

    // /model 命令注册在独立 scope（commandUi 贡献已捕获）。
    expect(h.commandDisposers).toHaveLength(1);
  });

  it('/model command：ACP Remote 不可用时，已知 native→native 仍走 DSH 原生 selectModel', async () => {
    const h = createFakeCtx({
      remoteReady: true,
      backendOf: Promise.resolve({ ok: false as const, error: { message: 'ACP unavailable' } }),
      models: {
        current: { provider: 'openai', model: 'gpt-old' },
        routable: true,
        groups: [{
          id: 'openai',
          name: 'OpenAI',
          models: [
            { id: 'gpt-old', name: 'GPT Old' },
            { id: 'gpt-mini', name: 'GPT Mini' },
          ],
        }],
        failures: [],
      },
    });
    apply(h.ctx as never);
    const command = h.commandEntries[0] as {
      ui: {
        options(session: { sessionId: string }): Promise<Array<{ id: string }>>
        onSelect(option: { id: string }, session: { sessionId: string }): Promise<void>
      }
    };
    const options = await command.ui.options({ sessionId: 'sess-1' });
    const target = options.find((option) => option.id.includes('gpt-mini'));
    expect(target).toBeDefined();
    await command.ui.onSelect(target!, { sessionId: 'sess-1' });
    expect(h.selectCalls).toEqual([{ sessionId: 'sess-1', provider: 'openai', model: 'gpt-mini' }]);
  });

  it('accepts only the Alpha RemoteResult envelope, not the retired nested result wrapper', async () => {
    const h = createFakeCtx({
      remoteReady: true,
      nestedRemoteResult: true,
      backendOf: Promise.resolve({ ok: false as const, error: { message: 'ACP unavailable' } }),
      models: {
        current: { provider: 'openai', model: 'gpt-old' },
        routable: true,
        groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-old', name: 'GPT Old' }] }],
        failures: [],
      },
    });
    apply(h.ctx as never);
    const command = h.commandEntries[0] as { ui: { options(session: { sessionId: string }): Promise<unknown[]> } };
    await expect(command.ui.options({ sessionId: 'sess-1' })).resolves.toEqual([]);
  });

  it('卸载残留：全部 fiber disposer 跑完后零残留', () => {
    const h = createFakeCtx();
    apply(h.ctx as never);

    // 模拟 scope 通知存活（卸载前基线：订阅在）。
    h.notifyScope();
    expect(h.registeredEntries).toHaveLength(8);

    // fiber 卸载：cordis 逆序跑 effect disposers（本 fake 顺序无关——断言全集）。
    for (const { run } of h.effectDisposers) run();
    for (const { dispose } of h.slotInjectDisposers) dispose();

    // locale 两个命名空间退订。
    expect(h.localeUnregisters.map((entry) => entry.ns).sort()).toEqual(['acp-model', 'settings.acp']);
    for (const { dispose } of h.localeUnregisters) expect(dispose).toHaveBeenCalledTimes(1);

    // controller dispose → settings scope 退订（sink 断开由 picker-service/panel
    // 级行为钉覆盖；这里钉退订动作本身）。
    expect(h.scopeUnsub).toHaveBeenCalledTimes(1);

    // pickerService dispose → remote 两路事件 + connection/reset 通道退订。
    expect(h.remoteUnsubs.map((entry) => entry.name).sort()).toEqual([
      'llm/adapters-updated',
      'settings/document-updated',
    ]);
    for (const { dispose } of h.remoteUnsubs) expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.connectionResetUnsubs).toHaveLength(1);

    // effect 登记齐全：两个字典 + controller + pickerService + commandUi 贡献。
    expect(h.effectDisposers).toHaveLength(5);

    // 卸载后 scope 再通知不抛错（controller 已退订，无监听者）。
    expect(() => { h.notifyScope(); }).not.toThrow();
  });
});

// ----------：per-contribution 失败隔离 ----------

describe(' per-contribution 隔离（可选 ACP 子模块失败不撤销 picker 核心）', () => {
  it('permission input dock 注册失败：elicitation / picker / toolview / /model / 设置面板照常挂载', () => {
    const h = createFakeCtx({ failOnRegisterId: 'acp-permissions' });
    apply(h.ctx as never);

    const names = h.registeredEntries.map((entry) => entry.name);
    expect(names).toEqual(['settings.section', 'conversation.session.header.utilities', 'conversation.input.model', 'conversation.input.dock', 'conversation.composer.dock', 'conversation.input.dock', 'tool.call.toolview']);
    expect(h.registeredEntries.find((entry) => entry.id === 'acp-elicitations')?.id).toBe('acp-elicitations');
    expect(h.commandDisposers).toHaveLength(1);
  });

  it('elicitation input dock 注册失败：permission / picker / toolview / /model / 设置面板照常挂载', () => {
    const h = createFakeCtx({ failOnRegisterId: 'acp-elicitations' });
    apply(h.ctx as never);

    const names = h.registeredEntries.map((entry) => entry.name);
    expect(names).toEqual(['settings.section', 'conversation.session.header.utilities', 'conversation.input.model', 'conversation.input.dock', 'conversation.composer.dock', 'conversation.input.dock', 'tool.call.toolview']);
    expect(h.registeredEntries.find((entry) => entry.id === 'acp-permissions')?.id).toBe('acp-permissions');
    expect(h.commandDisposers).toHaveLength(1);
  });

  it('toolview 注册失败：picker seat / dock / /model / 设置面板照常挂载', () => {
    const h = createFakeCtx({ failOnRegister: 'tool.call.toolview' });
    apply(h.ctx as never);

    const names = h.registeredEntries.map((entry) => entry.name);
    expect(names).toEqual(['settings.section', 'conversation.session.header.utilities', 'conversation.input.model', 'conversation.input.dock', 'conversation.composer.dock', 'conversation.input.dock', 'conversation.input.dock']);
    expect(h.commandDisposers).toHaveLength(1);
  });

  it('picker seat 注册失败：/model 命令与 dock/toolview/设置面板不被拖垮', () => {
    const h = createFakeCtx({ failOnRegister: 'conversation.input.model' });
    apply(h.ctx as never);

    const names = h.registeredEntries.map((entry) => entry.name);
    expect(names).toEqual(['settings.section', 'conversation.session.header.utilities', 'conversation.input.dock', 'conversation.composer.dock', 'conversation.input.dock', 'conversation.input.dock', 'tool.call.toolview']);
    expect(h.commandDisposers).toHaveLength(1);
  });

  it('pickerService 装配失败（宿主面漂移）：fail closed——picker 族贡献全禁，设置面板存活并点名', () => {
    const h = createFakeCtx({ failRemoteOn: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(h.ctx as never);
    const errorCalls = errorSpy.mock.calls.map((args) => String(args[0]));
    errorSpy.mockRestore();

    const names = h.registeredEntries.map((entry) => entry.name);
    // picker 族（seat/dock/toolview + /model 命令）全部缺席；面板存活
    expect(names).toEqual(['settings.section']);
    expect(h.commandDisposers).toHaveLength(0);
    expect(errorCalls.some((first) => first.includes('[dsh-acp] model picker contributions disabled'))).toBe(true);
  });
});
