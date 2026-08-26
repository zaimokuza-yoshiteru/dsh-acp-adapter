// model-switch.spec.ts — ModelSwitchCoordinator 的 host 侧（dshAcp Remote
// begin/commit/rollbackModelSwitch + stale liveOptions）随附测试。
//
// 被测对象：AcpRemoteService（src/remote/service.ts）直驱，持久 seam 用真
// sidecar（tmp root 的 SQLite）以钉住跨「崩溃」的事务行语义；活体 agent 用
// 结构假件（setConfigOption 模拟「响应完整快照替换」契约与可控失败臂）。
//
// 覆盖：
//   beginModelSwitch
//   - 成功流：started → setConfigOption → 权威快照读 actualModel → agent-applied
//     落账；快照 modelSwitch 视图为 pending(agent-applied)
//   - 预检：空 operationId/targetModel、无活体、无 model 类 option、target 不在
//     allowed values、忙（running）、store 未接线（fail-closed）一律响亮拒绝
//   - previous === target → 无操作（不落事务行）
//   - Agent 拒绝 → 回滚臂写回 previous + 清行后原样抛出；回滚也失败 →
//     rollback-required 落账 + 锁定文案
//   - 幂等/并发：同 operationId 重复投递按行状态收敛（agent-applied 直接返回；
//     started 以活体当前值自证）；不同 operationId 在飞/待定 → 冲突拒绝
//   commitModelSwitch
//   - 成功：committed 落账后清行（同事务窗）；无行幂等返回快照；operationId
//     不匹配 / rollback-required → 拒绝
//   rollbackModelSwitch
//   - 成功：Agent 写回 previous + 清行；无行幂等；无活体响亮拒绝；回滚写失败
//     → rollback-required 落账 + 原样抛出
// stale liveOptions
//   - 无活体 + sidecar 快照 → freshness 'stale' / editable false / capabilities
//     null / configOptions 由快照重组；指纹漂移 → fingerprintChanged true
//   - 无快照 → 维持旧「no live ACP agent」抛错

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type * as acp from '@agentclientprotocol/sdk'
import {
  AcpRemoteService,
  type AcpHealthRegistryLike,
  type AcpLiveAgentFace,
  type AcpRemoteServiceDeps,
} from '../../../src/remote/service.ts'
import { acpOptionsSnapshotOf, createAcpSidecar, type AcpPendingModelSwitch, type AcpSidecar } from '../../../src/persistence/sidecar.ts'

const SESSION = 'sess-1'
const ROUTE = 'acp-test'

const MODEL_OPTION: acp.SessionConfigOption = {
  type: 'select',
  id: 'model',
  category: 'model',
  name: 'Model',
  currentValue: 'm1',
  options: [
    { value: 'm1', name: 'M1' },
    { value: 'm2', name: 'M2' },
  ],
}

// ---------- 假活体 agent（setConfigOption 响应权威替换 + 可控失败臂） ----------

interface FakeAgentSpec {
  status?: 'idle' | 'running'
  configOptions?: acp.SessionConfigOption[] | undefined
  /** setConfigOption 的失败脚本：键 = 第几次调用（1 起），值 = 抛出的错误。 */
  failOn?: Record<number, Error>
  /** 非 undefined 时 setConfigOption 返回该 deferred（并发闩锁用例用；entered 在 seam 进入时点火）。 */
  deferred?: { promise: Promise<void>; resolve: () => void; entered: () => void }
  /** 模拟 Agent 接受请求后把模型 id 归一化成另一权威值。 */
  normalizeTo?: string
}

function makeLiveAgent(spec: FakeAgentSpec = {}) {
  const state = {
    status: spec.status ?? ('idle' as 'idle' | 'running'),
    configOptions: spec.configOptions === undefined ? [structuredClone(MODEL_OPTION)] : spec.configOptions,
  }
  const calls: Array<[string, string | boolean]> = []
  const face: AcpLiveAgentFace = {
    providerRoute: ROUTE,
    get status() {
      return state.status
    },
    get configOptions() {
      return state.configOptions
    },
    get currentModeId() {
      return 'code'
    },
    get agentCapabilities() {
      return undefined
    },
    get contextUsage() {
      return null
    },
    get continuityState() {
      return { status: 'ok' as const, cause: null, detail: null }
    },
    rebindBlank() {
      return Promise.resolve()
    },
    setConfigOption(configId, value) {
      calls.push([configId, value])
      const scripted = spec.failOn?.[calls.length]
      if (scripted !== undefined) return Promise.reject(scripted)
      if (spec.deferred !== undefined) {
        spec.deferred.entered()
        return spec.deferred.promise
      }
      const option = state.configOptions?.find((candidate) => candidate.id === configId)
      // seam 契约：成功后以响应的完整 configOptions 替换本地快照
      if (option?.type === 'select' && typeof value === 'string') option.currentValue = spec.normalizeTo ?? value
      return Promise.resolve()
    },
    setMode() {
      return Promise.resolve()
    },
  }
  return { face, calls, state }
}

// ---------- 真 sidecar + service 组装 ----------

let root = ''
let sidecar: AcpSidecar

function pendingRow(state: AcpPendingModelSwitch['state'], overrides: Partial<AcpPendingModelSwitch> = {}): AcpPendingModelSwitch {
  return {
    operationId: 'op-1',
    dshSessionId: SESSION,
    provider: ROUTE,
    optionId: 'model',
    previousModel: 'm1',
    targetModel: 'm2',
    state,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

async function readRow(sessionId = SESSION) {
  return sidecar.readPendingModelSwitch(SessionId(sessionId))
}

interface BuildParts {
  liveAgents?: Map<string, AcpLiveAgentFace>
  /** false = 不接线 modelSwitchStore（fail-closed 用例）。 */
  withSwitchStore?: boolean
  fingerprint?: string | undefined
}

function buildService(parts: BuildParts = {}) {
  const registry: AcpHealthRegistryLike = {
    agents: () => new Map(),
    probeCache: {
      probeSnapshot: () => undefined,
      invalidateProbe: () => undefined,
      listModels: () => Promise.resolve([]),
    },
  }
  const deps: AcpRemoteServiceDeps = {
    registry,
    resolveLiveAgent: (sessionId) => parts.liveAgents?.get(sessionId),
    ...(parts.withSwitchStore === false
      ? {}
      : {
          modelSwitchStore: {
            read: (sessionId: string) => sidecar.readPendingModelSwitch(SessionId(sessionId)),
            write: (record) => sidecar.writePendingModelSwitch(record as AcpPendingModelSwitch),
            clear: (sessionId: string) => sidecar.clearPendingModelSwitch(SessionId(sessionId)),
          },
        }),
    optionSnapshotStore: {
      read: (sessionId: string) => sidecar.readOptionSnapshot(SessionId(sessionId)),
    },
    ...(parts.fingerprint === undefined ? {} : { snapshotFingerprint: () => Promise.resolve(parts.fingerprint) }),
  }
  return new AcpRemoteService(new Context(), deps)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-model-switch-spec-'))
  sidecar = createAcpSidecar({ root })
})

afterEach(async () => {
  await sidecar.dispose().catch(() => undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------- beginModelSwitch ----------

describe('dshAcp/beginModelSwitch', () => {
  it('成功流：started 落账 → setConfigOption → 权威快照读 actualModel → agent-applied 落账', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    const result = await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    expect(agent.calls).toEqual([['model', 'm2']])
    expect(result.actualModel).toBe('m2')
    expect(result.snapshot.freshness).toBe('live')
    expect(result.snapshot.modelSwitch).toMatchObject({ status: 'pending', state: 'agent-applied', operationId: 'op-1', targetModel: 'm2' })
    // 行内容逐字段（createdAt 是墙钟，单独钉形态）
    const lookup = await readRow()
    expect(lookup?.status).toBe('ok')
    if (lookup?.status === 'ok') {
      expect({ ...lookup.record, createdAt: '<wall-clock>' }).toEqual({
        ...pendingRow('agent-applied'),
        appliedModel: 'm2',
        createdAt: '<wall-clock>',
      })
      expect(Date.parse(lookup.record.createdAt)).not.toBeNaN()
    }
  })

  it('Agent 归一化模型 id：actualModel 与 sidecar appliedModel 都保存权威值', async () => {
    const agent = makeLiveAgent({ normalizeTo: 'm2-normalized' })
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    const result = await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    expect(result.actualModel).toBe('m2-normalized')
    const lookup = await readRow()
    expect(lookup?.status === 'ok' && lookup.record).toMatchObject({
      targetModel: 'm2', appliedModel: 'm2-normalized', state: 'agent-applied',
    })
  })

  it('预检拒绝矩阵：空 operationId / 空 targetModel / 无活体 / 无 model 类 option / target 非可选值 / 忙 / store 未接线', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: '', targetModel: 'm2' })).rejects.toThrow('non-empty operationId')
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: '' })).rejects.toThrow('non-empty targetModel')
    await expect(service.beginModelSwitch('ghost', { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('no live ACP agent')

    const noModel = makeLiveAgent({ configOptions: [{ type: 'boolean', id: 'fast', name: 'Fast', currentValue: false }] })
    const service2 = buildService({ liveAgents: new Map([[SESSION, noModel.face]]) })
    await expect(service2.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('no model-class config option')

    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm9' })).rejects.toThrow('not a selectable value')

    const busy = makeLiveAgent({ status: 'running' })
    const service3 = buildService({ liveAgents: new Map([[SESSION, busy.face]]) })
    await expect(service3.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('retry when idle')

    const service4 = buildService({ liveAgents: new Map([[SESSION, agent.face]]), withSwitchStore: false })
    await expect(service4.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('not wired')
    // 预检全拒：零 seam 调用、零事务行
    expect(agent.calls).toEqual([])
    expect(await readRow()).toBeUndefined()
  })

  it('previous === target：无操作（不落事务行、不调 seam），返回现状快照', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    const result = await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm1' })
    expect(result.actualModel).toBe('m1')
    expect(result.snapshot.modelSwitch).toEqual({ status: 'idle' })
    expect(agent.calls).toEqual([])
    expect(await readRow()).toBeUndefined()
  })

  it('Agent 拒绝 → 回滚臂写回 previous + 清行后原样抛出', async () => {
    const boom = new Error('agent rejected the model')
    const agent = makeLiveAgent({ failOn: { 1: boom } })
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('agent rejected the model')
    // 先写 target（失败）再写回 previous（成功）
    expect(agent.calls).toEqual([['model', 'm2'], ['model', 'm1']])
    expect(agent.state.configOptions?.[0]).toMatchObject({ currentValue: 'm1' })
    expect(await readRow()).toBeUndefined()
  })

  it('回滚也失败 → rollback-required 落账 + 锁定文案；快照视图即 rollback-required', async () => {
    const agent = makeLiveAgent({ failOn: { 1: new Error('switch boom'), 2: new Error('rollback boom') } })
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('the session is locked (rollback-required)')
    expect(agent.calls).toEqual([['model', 'm2'], ['model', 'm1']])
    const lookup = await readRow()
    expect(lookup?.status === 'ok' && lookup.record.state).toBe('rollback-required')
    const snapshot = await service.liveOptions(SESSION)
    expect(snapshot.modelSwitch).toEqual({ status: 'rollback-required', operationId: 'op-1', provider: 'acp-test', previousModel: 'm1', targetModel: 'm2' })
  })

  it('同 operationId 重复投递：agent-applied 行直接收敛返回（零二次写 Agent）', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    const again = await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    expect(again.actualModel).toBe('m2')
    expect(agent.calls).toEqual([['model', 'm2']]) // 恰好一次
  })

  it('同 operationId 重复投递：Agent 已漂移时拒绝采纳漂移值并保留事务行', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    agent.state.configOptions![0]!.currentValue = 'm3'

    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' }))
      .rejects.toThrow('instead of the journaled applied model')
    const lookup = await readRow()
    expect(lookup?.status === 'ok' && lookup.record.state).toBe('agent-applied')
    expect(agent.calls).toEqual([['model', 'm2']])
  })

  it('started 行重投递：活体当前值 === target → 自证已应用，收敛 agent-applied', async () => {
    await sidecar.writePendingModelSwitch(pendingRow('started'))
    // 崩溃点①的另一面：Agent 其实已经应用了（崩溃在落 agent-applied 之前）
    const agent = makeLiveAgent()
    agent.state.configOptions![0]!.currentValue = 'm2'
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    const result = await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    expect(result.actualModel).toBe('m2')
    expect(agent.calls).toEqual([]) // 不重写 Agent
    const lookup = await readRow()
    expect(lookup?.status === 'ok' && lookup.record.state).toBe('agent-applied')
  })

  it('started 行重投递：活体当前值 === previous → 按未应用清行并拒发（提示重试）', async () => {
    await sidecar.writePendingModelSwitch(pendingRow('started'))
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('never applied by the agent')
    expect(agent.calls).toEqual([])
    expect(await readRow()).toBeUndefined()
  })

  it('started 行重投递：活体模型不可读 → 保留事务行并响亮拒绝（不能猜测未应用）', async () => {
    await sidecar.writePendingModelSwitch(pendingRow('started'))
    const agent = makeLiveAgent({ configOptions: [] })
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' }))
      .rejects.toThrow('agent model could not be read')
    const lookup = await readRow()
    expect(lookup?.status === 'ok' && lookup.record.state).toBe('started')
  })

  it('不同 operationId：待定行在场 → 冲突拒绝；在飞闩锁 → 并发拒绝', async () => {
    await sidecar.writePendingModelSwitch(pendingRow('agent-applied'))
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-2', targetModel: 'm2' })).rejects.toThrow('pending model switch')

    // 在飞闩锁：第一次 begin 卡在 setConfigOption 上，第二次（异 operationId）即拒
    await sidecar.clearPendingModelSwitch(SessionId(SESSION))
    let release!: () => void
    let entered!: () => void
    const enteredOnce = new Promise<void>((resolve) => { entered = resolve })
    const deferred = { promise: new Promise<void>((resolve) => { release = resolve }), resolve: () => release(), entered }
    const slow = makeLiveAgent({ deferred })
    const service2 = buildService({ liveAgents: new Map([[SESSION, slow.face]]) })
    const first = service2.beginModelSwitch(SESSION, { operationId: 'op-a', targetModel: 'm2' })
    await enteredOnce // 等第一次 begin 持闩进 seam，再发起并发
    await expect(service2.beginModelSwitch(SESSION, { operationId: 'op-b', targetModel: 'm2' })).rejects.toThrow('in flight')
    release()
    await first
  })

  it('corrupt 行：begin 响亮拒绝（reconciliation-required 出路），不碰 Agent', async () => {
    await sidecar.writePendingModelSwitch(pendingRow('started'))
    // 经原始连接把 payload 篡改畸形
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(root, 'sidecar.sqlite'))
    try {
      db.prepare('UPDATE model_switches SET payload = ? WHERE dsh_session_id = ?').run('{broken', SESSION)
    } finally {
      db.close()
    }
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })).rejects.toThrow('corrupt pending model switch')
    expect(agent.calls).toEqual([])
    const snapshot = await service.liveOptions(SESSION)
    expect(snapshot.modelSwitch).toEqual({ status: 'corrupt' })
  })
})

// ---------- commitModelSwitch ----------

describe('dshAcp/commitModelSwitch', () => {
  it('成功：committed 落账后清行（同一连贯窗口），返回 idle 视图快照', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    const snapshot = await service.commitModelSwitch(SESSION, { operationId: 'op-1' })
    expect(await readRow()).toBeUndefined()
    expect(snapshot.modelSwitch).toEqual({ status: 'idle' })
  })

  it('幂等：无行（响应丢失但清行已发生）→ 直接返回快照；重复 commit 不抛', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    const snapshot = await service.commitModelSwitch(SESSION, { operationId: 'op-lost' })
    expect(snapshot.modelSwitch).toEqual({ status: 'idle' })
  })

  it('operationId 不匹配 / rollback-required 行 → 响亮拒绝', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await service.beginModelSwitch(SESSION, { operationId: 'op-1', targetModel: 'm2' })
    await expect(service.commitModelSwitch(SESSION, { operationId: 'op-2' })).rejects.toThrow('not op-2')
    await sidecar.writePendingModelSwitch(pendingRow('rollback-required'))
    await expect(service.commitModelSwitch(SESSION, { operationId: 'op-1' })).rejects.toThrow('rollback-required')
  })

  it('无活体 → 抛错；store 未接线 → fail-closed', async () => {
    const service = buildService()
    await expect(service.commitModelSwitch(SESSION, { operationId: 'op-1' })).rejects.toThrow('no live ACP agent')
    const agent = makeLiveAgent()
    const service2 = buildService({ liveAgents: new Map([[SESSION, agent.face]]), withSwitchStore: false })
    await expect(service2.commitModelSwitch(SESSION, { operationId: 'op-1' })).rejects.toThrow('not wired')
  })
})

// ---------- rollbackModelSwitch ----------

describe('dshAcp/rollbackModelSwitch', () => {
  it('成功：Agent 写回 previousModel + 持久化 agent-rolled-back；finalize 后才清行', async () => {
    const agent = makeLiveAgent()
    agent.state.configOptions![0]!.currentValue = 'm2' // Agent 已应用 target
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await sidecar.writePendingModelSwitch(pendingRow('agent-applied'))
    const snapshot = await service.rollbackModelSwitch(SESSION, { operationId: 'op-1' })
    expect(agent.calls).toEqual([['model', 'm1']])
    expect(agent.state.configOptions?.[0]).toMatchObject({ currentValue: 'm1' })
    expect(await readRow()).toEqual({ status: 'ok', record: pendingRow('agent-rolled-back') })
    expect(snapshot.modelSwitch).toMatchObject({ status: 'pending', state: 'agent-rolled-back' })
    const finalized = await service.commitModelSwitch(SESSION, { operationId: 'op-1' })
    expect(await readRow()).toBeUndefined()
    expect(finalized.modelSwitch).toEqual({ status: 'idle' })
  })

  it('幂等：无行 → 直接返回快照（零 seam 调用）', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    const snapshot = await service.rollbackModelSwitch(SESSION, { operationId: 'op-lost' })
    expect(snapshot.modelSwitch).toEqual({ status: 'idle' })
    expect(agent.calls).toEqual([])
  })

  it('无活体（冷启动）：响亮拒绝并指明出路（resume / rebind）', async () => {
    const service = buildService()
    await sidecar.writePendingModelSwitch(pendingRow('rollback-required'))
    await expect(service.rollbackModelSwitch(SESSION, { operationId: 'op-1' })).rejects.toThrow('resume the session')
    // 行保留（恢复路径还需它自证）
    expect((await readRow())?.status).toBe('ok')
  })

  it('回滚写失败 → rollback-required 落账 + 原样抛出', async () => {
    const agent = makeLiveAgent({ failOn: { 1: new Error('still refusing') } })
    agent.state.configOptions![0]!.currentValue = 'm2'
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await sidecar.writePendingModelSwitch(pendingRow('agent-applied'))
    await expect(service.rollbackModelSwitch(SESSION, { operationId: 'op-1' })).rejects.toThrow('still refusing')
    const lookup = await readRow()
    expect(lookup?.status === 'ok' && lookup.record.state).toBe('rollback-required')
  })

  it('operationId 不匹配 / corrupt 行 → 响亮拒绝；忙 → 提示 idle 重试', async () => {
    const agent = makeLiveAgent()
    const service = buildService({ liveAgents: new Map([[SESSION, agent.face]]) })
    await sidecar.writePendingModelSwitch(pendingRow('agent-applied'))
    await expect(service.rollbackModelSwitch(SESSION, { operationId: 'op-2' })).rejects.toThrow('not op-2')

    const busy = makeLiveAgent({ status: 'running' })
    const service2 = buildService({ liveAgents: new Map([[SESSION, busy.face]]) })
    await expect(service2.rollbackModelSwitch(SESSION, { operationId: 'op-1' })).rejects.toThrow('retry the rollback when idle')
  })
})

// ---------- stale liveOptions ----------

describe('dshAcp/options stale 快照（冷启动）', () => {
  const FINGERPRINT = 'fp-current'

  async function seedSnapshot(fingerprint = FINGERPRINT) {
    await sidecar.writeOptionSnapshot(
      SessionId(SESSION),
      acpOptionsSnapshotOf(
        [
          { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'm2', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] } as never,
          { type: 'boolean', id: 'fast', name: 'Fast', currentValue: true } as never,
        ],
        'plan',
        fingerprint,
        1_700_000_000_000,
      ),
    )
  }

  it('无活体 + sidecar 快照：freshness stale / editable false / capabilities null / configOptions 重组', async () => {
    await seedSnapshot()
    const service = buildService({ fingerprint: FINGERPRINT })
    const snapshot = await service.liveOptions(SESSION)
    expect(snapshot).toEqual({
      sessionId: SESSION,
      configOptions: [
        { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'm2', options: [{ value: 'm1', name: 'm1' }, { value: 'm2', name: 'm2' }] },
        { type: 'boolean', id: 'fast', name: 'Fast', currentValue: true },
      ],
      currentModeId: 'plan',
      capabilities: null,
      continuity: { status: 'ok', cause: null, detail: null },
      contextUsage: null,
      freshness: 'stale',
      editable: false,
      fingerprintChanged: false,
      modelSwitch: { status: 'idle' },
    })
  })

  it('指纹漂移（当前配置重组指纹 ≠ 快照指纹）→ fingerprintChanged true；seam 未接线 → 恒 false', async () => {
    await seedSnapshot('fp-old')
    const service = buildService({ fingerprint: 'fp-new' })
    expect((await service.liveOptions(SESSION)).fingerprintChanged).toBe(true)
    const service2 = buildService()
    expect((await service2.liveOptions(SESSION)).fingerprintChanged).toBe(false)
  })

  it('stale 期间写路径全拒：setOption / beginModelSwitch 抛「no live ACP agent」；pending 行视图仍如实透出', async () => {
    await seedSnapshot()
    await sidecar.writePendingModelSwitch(pendingRow('rollback-required'))
    const service = buildService()
    const snapshot = await service.liveOptions(SESSION)
    expect(snapshot.modelSwitch).toEqual({ status: 'rollback-required', operationId: 'op-1', provider: 'acp-test', previousModel: 'm1', targetModel: 'm2' })
    await expect(service.setOption(SESSION, { configId: 'fast', value: false })).rejects.toThrow('no live ACP agent')
    await expect(service.beginModelSwitch(SESSION, { operationId: 'op-2', targetModel: 'm1' })).rejects.toThrow('no live ACP agent')
  })

  it('无活体且无快照：维持旧行为（抛 no live ACP agent，不冒充空快照）', async () => {
    const service = buildService()
    await expect(service.liveOptions(SESSION)).rejects.toThrow('no live ACP agent')
  })
})
