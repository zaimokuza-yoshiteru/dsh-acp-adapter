// model-switch-controller.spec.ts — ModelSwitchCoordinator 的 client 侧
// （src/client/data/model-switch-controller.ts）随附测试。
//
// 被测对象：ModelSwitchController + 真 LiveOptionsController（假 remote 队列
// 喂 wire 快照）；directory/sessions 用结构假件（本 spec 钉协调器的编排次序
// 与失败补偿，目录/会话面的内部行为各有专 spec）。
//
// 覆盖：
//   switchModel
//   - 成功次序：begin → selectModel(actualModel) → commit；actualModel 为 host
//     回报值（Agent 可归一化请求值）
//   - Agent 拒绝（begin !ok）→ failSelection + 零 selectModel；DSH 拒绝 →
//     rollbackModelSwitch 补偿臂；commit 响应丢失 → 结局不翻转（仍 true）
//   - 预检：stale/不可编辑快照、未决切换在场、无 model 类 option、target 不在
//     目录 ∩ allowed values、并发点击——一律拒发（远程零调用）
//   recover（prime 后崩溃恢复）：pending 行按 decideModelSwitchRecovery 收敛
//   - clear / rollback-agent / complete-dsh / rollback-dsh / wait-resume /
//     undecidable 六决策的远程动作序列
//   rollback（用户出路）：rollback-required → Agent 回滚 + DSH 侧收敛 previous

import { describe, expect, it, vi } from 'vitest'
import { ModelSwitchController } from '../../../src/client/data/model-switch-controller.ts'
import { LiveOptionsController } from '../../../src/client/data/live-controller.ts'
import type { AcpRemoteLike } from '../../../src/client/data/acp-remote.ts'
import type { SessionModelDirectory } from '../../../src/client/data/directory-controller.ts'
import type { SessionsWireLike } from '../../../src/client/data/picker-wire.ts'
import type { LiveOptionsSnapshot, PickerModelSelection } from '../../../src/client/data/selector-logic.ts'

const SESSION_ID = 'sess-1'
const PROVIDER = 'acp-test'

type WireResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }

// ---------- wire 快照夹具 ----------

function liveWire(modelSwitch: LiveOptionsSnapshot['modelSwitch'], modelValue = 'm1') {
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
    freshness: 'live',
    editable: true,
    fingerprintChanged: false,
    modelSwitch,
  }
}

const IDLE = { status: 'idle' } as const

function pendingWire(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending' as const,
    operationId: 'op-1',
    state: 'agent-applied' as const,
    provider: PROVIDER,
    optionId: 'model',
    previousModel: 'm1',
    targetModel: 'm2',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------- 假件 ----------

function makeRemote(overrides: Partial<Record<'begin' | 'commit' | 'rollback', WireResult<never>>> = {}) {
  const order: string[] = []
  const optionsQueue: unknown[] = []
  const remote = {
    options: vi.fn(() => {
      order.push('options')
      const wire = optionsQueue.shift() ?? liveWire(IDLE)
      return Promise.resolve({ ok: true as const, value: wire })
    }),
    beginModelSwitch: vi.fn((_sessionId: string, _request: { operationId: string; targetModel: string }) => {
      order.push('begin')
      return Promise.resolve(overrides.begin ?? { ok: true as const, value: { actualModel: _request.targetModel, snapshot: liveWire(pendingWire(), _request.targetModel) } })
    }),
    commitModelSwitch: vi.fn((_sessionId: string, _request: { operationId: string }) => {
      order.push('commit')
      return Promise.resolve(overrides.commit ?? { ok: true as const, value: liveWire(IDLE) })
    }),
    rollbackModelSwitch: vi.fn((_sessionId: string, _request: { operationId: string }) => {
      order.push('rollback')
      return Promise.resolve(overrides.rollback ?? { ok: true as const, value: liveWire(IDLE) })
    }),
  }
  return { remote: remote as unknown as AcpRemoteLike, order, optionsQueue, fns: remote }
}

function makeSessions(fault?: Error, rejection?: { message: string }) {
  const selectModel = vi.fn((input: { sessionId: string; provider: string; model: string }) => {
    if (fault !== undefined) return Promise.reject(fault)
    if (rejection !== undefined) return Promise.resolve({ result: { ok: false as const, error: rejection } })
    return Promise.resolve({
      result: { ok: true as const, value: { selected: { provider: input.provider, model: input.model } } },
    })
  })
  return { sessions: { selectModel } as unknown as SessionsWireLike, selectModel }
}

function makeDirectory(current: { provider: string; model: string } | null = { provider: PROVIDER, model: 'm1' }) {
  const calls = { beginSelection: 0, failSelection: [] as string[], applied: [] as PickerModelSelection[] }
  const directory = {
    getSnapshot: () => ({
      groups: [{ id: PROVIDER, name: 'Test · ACP', models: [{ id: 'm1' }, { id: 'm2' }] }],
      current,
    }),
    beginSelection: () => {
      calls.beginSelection += 1
    },
    failSelection: (message: string) => {
      calls.failSelection.push(message)
    },
    applySyncedSelection: (selection: PickerModelSelection) => {
      calls.applied.push(selection)
    },
  }
  return { directory: directory as unknown as SessionModelDirectory, calls }
}

interface HarnessParts {
  remoteOverrides?: Parameters<typeof makeRemote>[0]
  sessionsFault?: Error
  sessionsRejection?: { message: string }
  current?: { provider: string; model: string } | null
}

async function makeHarness(parts: HarnessParts = {}, initialWire: unknown = liveWire(IDLE)) {
  const r = makeRemote(parts.remoteOverrides)
  r.optionsQueue.push(initialWire)
  const s = makeSessions(parts.sessionsFault, parts.sessionsRejection)
  const d = makeDirectory(parts.current)
  const live = new LiveOptionsController({ sessionId: SESSION_ID, remote: r.remote })
  await live.load()
  r.order.length = 0 // 首载的 options 调用不计入用例的动作序列
  const controller = new ModelSwitchController({
    sessionId: SESSION_ID,
    remote: r.remote,
    sessions: s.sessions,
    directory: d.directory,
    live,
  })
  return { controller, live, ...r, ...s, ...d }
}

// ---------- switchModel ----------

describe('ModelSwitchController.switchModel', () => {
  it('成功次序：begin → selectModel(actualModel) → commit；快照逐拍落 live', async () => {
    const h = await makeHarness()
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(true)
    expect(h.order).toEqual(['begin', 'commit'])
    expect(h.selectModel).toHaveBeenCalledTimes(1)
    expect(h.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: PROVIDER, model: 'm2' })
    expect(h.calls.applied).toEqual([{ provider: PROVIDER, model: 'm2' }])
    expect(h.calls.failSelection).toEqual([])
    // commit 响应快照已落 live：modelSwitch 视图归 idle
    expect(h.live.getSnapshot().snapshot?.modelSwitch).toEqual(IDLE)
  })

  it('actualModel 是 host 回报值（Agent 归一化请求值时 DSH 侧必须采纳回报值）', async () => {
    const h = await makeHarness({
      remoteOverrides: {
        begin: { ok: true, value: { actualModel: 'm2-normalized', snapshot: liveWire(pendingWire(), 'm2-normalized') } } as never,
      },
    })
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(true)
    expect(h.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: PROVIDER, model: 'm2-normalized' })
  })

  it('Agent 拒绝（begin !ok）→ failSelection(宿主 message)，零 selectModel/rollback', async () => {
    const h = await makeHarness({
      remoteOverrides: { begin: { ok: false, error: { message: 'agent rejected the model' } } as never },
    })
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(false)
    expect(h.calls.failSelection).toEqual(['agent rejected the model'])
    expect(h.selectModel).not.toHaveBeenCalled()
    expect(h.fns.rollbackModelSwitch).not.toHaveBeenCalled()
    expect(h.order).toEqual(['begin', 'options']) // 失败后刷新 live
  })

  it('DSH 明确拒绝（selectModel result.ok=false）→ rollbackModelSwitch 补偿臂 + failSelection，返回 false', async () => {
    const h = await makeHarness({ sessionsRejection: { message: 'workspace mutation refused' } })
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(false)
    expect(h.fns.rollbackModelSwitch).toHaveBeenCalledTimes(1)
    expect(h.fns.rollbackModelSwitch.mock.calls[0]?.[1]).toMatchObject({ operationId: expect.any(String) })
    expect(h.calls.failSelection).toEqual(['workspace mutation refused'])
    expect(h.calls.applied).toEqual([])
  })

  it('DSH selectModel 传输异常 → 不回滚 Agent，保留 pending 供恢复且退出 selecting', async () => {
    const h = await makeHarness({ sessionsFault: new Error('connection reset') })
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(false)
    expect(h.fns.rollbackModelSwitch).not.toHaveBeenCalled()
    expect(h.calls.failSelection[0]).toContain('outcome could not be confirmed')
    expect(h.calls.applied).toEqual([])
  })

  it('beginModelSwitch 传输异常 → 不猜测 Agent 结局，退出 selecting', async () => {
    const h = await makeHarness()
    h.fns.beginModelSwitch.mockRejectedValueOnce(new Error('begin connection reset'))
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(false)
    expect(h.fns.rollbackModelSwitch).not.toHaveBeenCalled()
    expect(h.calls.failSelection[0]).toContain('outcome could not be confirmed')
  })

  it('commit 响应丢失（!ok）→ 结局不翻转：返回 true，DSH 采纳保留（遗留行由恢复路径收敛）', async () => {
    const h = await makeHarness({ remoteOverrides: { commit: { ok: false, error: { message: 'connection lost' } } as never } })
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(true)
    expect(h.calls.applied).toEqual([{ provider: PROVIDER, model: 'm2' }])
    expect(h.calls.failSelection).toEqual([])
  })

  it('commit 传输异常 → 采纳 DSH 选择但保留 pending 供恢复', async () => {
    const h = await makeHarness()
    h.fns.commitModelSwitch.mockRejectedValueOnce(new Error('commit connection reset'))
    const ok = await h.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(ok).toBe(true)
    expect(h.calls.applied).toEqual([{ provider: PROVIDER, model: 'm2' }])
    expect(h.calls.failSelection).toEqual([])
  })

  it('预检拒发矩阵：stale / 未决切换 / 无 model 类 option / target 不在目录∩allowed / 并发点击', async () => {
    // stale 快照：只读，绝不授权热切换
    const stale = await makeHarness({}, { ...liveWire(IDLE) as object, freshness: 'stale', editable: false })
    expect(await stale.controller.switchModel({ provider: PROVIDER, model: 'm2' })).toBe(false)
    expect(stale.calls.failSelection[0]).toContain('read-only last-known copy')
    expect(stale.fns.beginModelSwitch).not.toHaveBeenCalled()

    // 未决切换在场（pending）：先收束再发起新切换
    const pend = await makeHarness({}, liveWire(pendingWire()))
    expect(await pend.controller.switchModel({ provider: PROVIDER, model: 'm2' })).toBe(false)
    expect(pend.calls.failSelection[0]).toContain('still unresolved')
    expect(pend.fns.beginModelSwitch).not.toHaveBeenCalled()

    // 无 model 类 option
    const noOption = await makeHarness({}, { ...(liveWire(IDLE) as object), configOptions: [] })
    expect(await noOption.controller.switchModel({ provider: PROVIDER, model: 'm2' })).toBe(false)
    expect(noOption.calls.failSelection[0]).toContain('no model-class config option')

    // target 不在 目录 ∩ allowed values
    const noValue = await makeHarness()
    expect(await noValue.controller.switchModel({ provider: PROVIDER, model: 'm9' })).toBe(false)
    expect(noValue.calls.failSelection[0]).toContain('not switchable')

    // 并发点击：第一次卡在 begin 上，第二次即拒
    let release!: () => void
    const gate = new Promise<WireResult<never>>((resolve) => {
      release = () => resolve({ ok: true, value: { actualModel: 'm2', snapshot: liveWire(pendingWire(), 'm2') } } as never)
    })
    const slow = await makeHarness()
    slow.fns.beginModelSwitch.mockImplementation(() => gate)
    const first = slow.controller.switchModel({ provider: PROVIDER, model: 'm2' })
    expect(await slow.controller.switchModel({ provider: PROVIDER, model: 'm2' })).toBe(false)
    release()
    expect(await first).toBe(true)
  })
})

// ---------- recover（崩溃恢复收敛） ----------

describe('ModelSwitchController.recover（prime 后的 pending 行收敛）', () => {
  it('非 pending 视图（idle/rollback-required/corrupt）：零远程动作', async () => {
    const h = await makeHarness()
    await h.controller.recover()
    expect(h.fns.commitModelSwitch).not.toHaveBeenCalled()
    expect(h.fns.rollbackModelSwitch).not.toHaveBeenCalled()
    expect(h.selectModel).not.toHaveBeenCalled()
  })

  it('clear（双侧一致）：commitModelSwitch 清行后刷新 live', async () => {
    // DSH current m2（目录）× Agent m2（live option）→ 已收敛
    const h = await makeHarness({ current: { provider: PROVIDER, model: 'm2' } }, liveWire(pendingWire(), 'm2'))
    await h.controller.recover()
    expect(h.fns.commitModelSwitch).toHaveBeenCalledWith(SESSION_ID, { operationId: 'op-1' })
    expect(h.fns.rollbackModelSwitch).not.toHaveBeenCalled()
    expect(h.selectModel).not.toHaveBeenCalled()
  })

  it('rollback-agent（DSH=previous、Agent 越出 target）：rollbackModelSwitch 后刷新', async () => {
    // DSH current m1（=previous）× Agent m3（被别的方式改动，越出 {previous,target}）→ 回滚 Agent 侧
    const h = await makeHarness({ current: { provider: PROVIDER, model: 'm1' } }, liveWire(pendingWire(), 'm3'))
    await h.controller.recover()
    expect(h.fns.rollbackModelSwitch).toHaveBeenCalledWith(SESSION_ID, { operationId: 'op-1' })
    expect(h.selectModel).not.toHaveBeenCalled()
  })

  it('complete-dsh（Agent=target、DSH=previous）：先 selectModel(target) 再 commit 清行', async () => {
    const h = await makeHarness({ current: { provider: PROVIDER, model: 'm1' } }, liveWire(pendingWire(), 'm2'))
    await h.controller.recover()
    expect(h.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: PROVIDER, model: 'm2' })
    expect(h.fns.commitModelSwitch).toHaveBeenCalledWith(SESSION_ID, { operationId: 'op-1' })
    expect(h.calls.applied).toEqual([{ provider: PROVIDER, model: 'm2' }])
  })

  it('rollback-dsh（DSH=target、Agent=previous）：selectModel(previous) 收敛 DSH 后 finalize', async () => {
    const h = await makeHarness({ current: { provider: PROVIDER, model: 'm2' } }, liveWire(pendingWire(), 'm1'))
    await h.controller.recover()
    expect(h.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: PROVIDER, model: 'm1' })
    expect(h.fns.commitModelSwitch).toHaveBeenCalledWith(SESSION_ID, { operationId: 'op-1' })
    expect(h.calls.applied).toEqual([{ provider: PROVIDER, model: 'm1' }])
  })

  it('wait-resume / undecidable：零写动作（证据不足绝不猜测）', async () => {
    // wait-resume：目录 current 缺席（dshModel null）
    const waiting = await makeHarness({ current: null }, liveWire(pendingWire(), 'm2'))
    await waiting.controller.recover()
    expect(waiting.selectModel).not.toHaveBeenCalled()
    expect(waiting.fns.commitModelSwitch).not.toHaveBeenCalled()
    expect(waiting.fns.rollbackModelSwitch).not.toHaveBeenCalled()

    // undecidable：DSH m9 × Agent m2，值集合越出 {m1, m2}
    const stuck = await makeHarness({ current: { provider: PROVIDER, model: 'm9' } }, liveWire(pendingWire(), 'm2'))
    await stuck.controller.recover()
    expect(stuck.selectModel).not.toHaveBeenCalled()
    expect(stuck.fns.commitModelSwitch).not.toHaveBeenCalled()
    expect(stuck.fns.rollbackModelSwitch).not.toHaveBeenCalled()
  })
})

// ---------- rollback（用户选择的出路） ----------

describe('ModelSwitchController.rollback（rollback-required 的行按钮）', () => {
  it('Agent 写回 previous + DSH 侧收敛 previous（current 不在 previous 时补 selectModel）', async () => {
    const wire = liveWire({ status: 'rollback-required', operationId: 'op-1', provider: PROVIDER, previousModel: 'm1', targetModel: 'm2' }, 'm2')
    const h = await makeHarness({ current: { provider: PROVIDER, model: 'm2' } }, wire)
    await h.controller.rollback()
    expect(h.fns.rollbackModelSwitch).toHaveBeenCalledWith(SESSION_ID, { operationId: 'op-1' })
    expect(h.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: PROVIDER, model: 'm1' })
    expect(h.calls.applied).toEqual([{ provider: PROVIDER, model: 'm1' }])
    expect(h.fns.commitModelSwitch).toHaveBeenCalledWith(SESSION_ID, { operationId: 'op-1' })
  })

  it('Agent 已回滚但 DSH 收敛失败：不 finalize，持久事务继续阻断', async () => {
    const wire = liveWire({ status: 'rollback-required', operationId: 'op-1', provider: PROVIDER, previousModel: 'm1', targetModel: 'm2' }, 'm2')
    const h = await makeHarness({ current: { provider: PROVIDER, model: 'm2' }, sessionsFault: new Error('DSH unavailable') }, wire)
    await h.controller.rollback()
    expect(h.fns.rollbackModelSwitch).toHaveBeenCalledTimes(1)
    expect(h.fns.commitModelSwitch).not.toHaveBeenCalled()
  })

  it('回滚失败（!ok）：不补 DSH 侧，只刷新 live（composer 保持阻断）', async () => {
    const wire = liveWire({ status: 'rollback-required', operationId: 'op-1', provider: PROVIDER, previousModel: 'm1', targetModel: 'm2' }, 'm2')
    const h = await makeHarness(
      { current: { provider: PROVIDER, model: 'm2' }, remoteOverrides: { rollback: { ok: false, error: { message: 'still refusing' } } as never } },
      wire,
    )
    await h.controller.rollback()
    expect(h.fns.rollbackModelSwitch).toHaveBeenCalledTimes(1)
    expect(h.selectModel).not.toHaveBeenCalled()
  })

  it('idle 视图：rollback 无操作（零远程调用）', async () => {
    const h = await makeHarness()
    await h.controller.rollback()
    expect(h.fns.rollbackModelSwitch).not.toHaveBeenCalled()
  })
})
