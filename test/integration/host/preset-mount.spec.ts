// preset-mount.spec.ts — 宿主模块实例一致性 集成回归：agent-presets 的 mount 真实路径过
// AcpAgent 的宿主 dsh-scope 作用域。
//
// 宿主模块实例一致性（浏览器新建 ACP 会话 100% 失败）：agent-presets 的 mount 首行
// scopeOf(agentCtx) 读 dsh-scope 的模块级私有 kScope 标签；AcpAgent 原先用
// cordis 原语复刻 scope，该标签永远缺席 → mount 以 "refusing to compose an
// unscoped context" 拒建会话。修复（方案 A，src/host-compat/host-scope.ts）后
// AcpAgent 的作用域由宿主 dsh-scope 的 createScope 创建，mount 全链路通过。
//
// 调用形态来自 DSH 0.1.1-rc.2 ApiProxy（api-proxy.ts: setup 内 presets.mount(agentCtx)）。
// 空 composition（顶层 []）经 entryListProblem 判合法、EntryTree 不产生任何
// 行，Entry/ctx.loader 方法面零触达——故 loader 用在场 fake 即可
// （AgentPresets / Include 的 static inject = ['loader'] 只要求服务在场）。
// settings 走 harness 的 FakeSettingsProvider：AgentPresets 构造器的
// inject(['settings']) 回调 register(ns, schema, {base})，mount  unnamed id
// 时 defaultId 读到 base.default，schema 函数本路径不触发。
//
// 修复前本测试必失败在 mount 首行的 unscoped 拒绝——既有 365 例漏检 宿主模块实例一致性
// 的原因正在于此：createHarness 路径从不过 agent-presets 的真实 mount。
//
// afterEach 兜底 dispose 全部 handle；共享 subprocess runtime 在文件结束时兜底回收。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import AgentPresets from '@deepseek-ai/dsh-agent-presets';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AcpAgent } from '../../../src/domain/session/agent.ts';
import {
  createHarness,
  mockProfile,
  registerAcpAgents,
  routeOf,
} from '../../fixtures/agent-test-helpers.ts';
import type { AgentHarness } from '../../fixtures/agent-test-helpers.ts';

let suiteDir = '';

/** 本测试文件创建的全部 harness；afterEach 统一拆除其 handle。 */
const harnesses: AgentHarness[] = [];

beforeAll(() => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-preset-mount-spec-'));
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const handle of harness.handles.splice(0).reverse()) {
      await handle.dispose().catch(() => {});
    }
  }
});

afterAll(() => {
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

describe('宿主模块实例一致性：agent-presets mount 过宿主 scope', () => {
  it('setup 内 mount(agentCtx) 成功，agent 加入默认 preset 的站住 composition', async () => {
    const logDir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
    const harness = await createHarness(logDir);
    harnesses.push(harness);
    const profile = mockProfile(harness.logDir, 'happy');
    await registerAcpAgents(harness, [profile]);

    // 临时 preset root：一个合法 id 的 preset 目录 + 空 composition（[]）。
    const presetRoot = fs.mkdtempSync(path.join(suiteDir, 'preset-root-'));
    fs.mkdirSync(path.join(presetRoot, 'acp-scope'));
    fs.writeFileSync(path.join(presetRoot, 'acp-scope', 'agent.cordis.yml'), '[]\n');

    // AgentPresets / Include 的 static inject = ['loader']：在场即可，空
    // composition 不触达其方法面。必须先 provide 再 plugin。
    harness.ctx.provide('loader', {});
    await harness.ctx.plugin(AgentPresets, {
      default: 'acp-scope',
      roots: [{ path: presetRoot, trust: 'user' }],
      includeUserRoot: false,
    });

    const handle = await harness.loop.createAgent(harness.ctx, {
      sessionId: SessionId('bug1-mount'),
      meta: { cwd: harness.logDir },
      agentOptions: { provider: routeOf(profile) },
      setup: async (agentCtx) => {
        // DSH 0.1.1-rc.2 ApiProxy 同款调用形态：unnamed id → defaultId（settings base）。
        await harness.ctx.agentPresets.mount(agentCtx);
      },
    });
    harness.handles.push(handle);

    expect(handle.agent).toBeInstanceOf(AcpAgent);
    // agent ctx 带宿主 dsh-scope 的 scope key（宿主模块实例一致性 修复的直证）。
    expect(scopeOf(handle.agent.ctx)).toBeDefined();
    // scope 父链已绑到 'acp-scope' 的站住 mount（bindScopeParent 生效）。
    expect(harness.ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('acp-scope');
  });
});
