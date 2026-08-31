// sidecar.spec.ts — SQLite WAL 重写后的随附测试（src/persistence/sidecar.ts）。
//
// 旧 JSONL 用例 → 新实现语义映射（门槛不降）：
// - v2 envelope 磁盘格式逐字段钉版 → list 逐行重建 v2 envelope
//   （schemaVersion/recordId/seq/time/kind/dshSessionId/acp*/payload），list 统一
//   读取模型不变；
// - binding 语义门槛（ok/outdated/undefined 三态、outdated 绝不回退）→ bindings
//   索引表 payload 全字段校验，畸形 binding 经 append（写路径不做语义校验，与 JSONL
//   时代一致）落索引后判 outdated；
// - 坏行容错（跳过 + warn）→ 行级校验容错：经第二个连接直插 SQL 的非法 audit 行
//   （unknown kind / 坏 JSON / seq 0 / 非对象 payload / 空 recordId）跳过 + warn；
//   JSONL 的「撕裂尾」「.corrupt-* 隔离」概念整体删除（SQLite 要么库损坏要么不损坏）；
// - 库级损坏（sidecar.sqlite 被覆写为垃圾）→ open 即 fail loud（warn + reject）；
// - Windows rename 占用重试（platform hooks）→ 随 src/persistence/platform.ts 整体
//   删除（tmp+rename 发布面被 SQLite commit/WAL 恢复取代）；
// - 原子写无 .tmp 残留 → 目录只出现 sidecar.sqlite 及其 -wal/-shm；
// - 并发 append 串行化 seq 独占、文件名安全边界（TypeError）、installAcpSidecar slot
//   选址——语义原样保留。
//
// 新增覆盖：权限位（目录 0700 / 库与 wal/shm 0600）、decided dedupe_key 幂等、
// 有界审计队列（满丢弃 + warn + flush 落齐；binding/permission/filesystem 同步 durable 不走
// 队列）、万条 append 快速回归、
// 旧 JSONL 残留一律忽略（不读不迁不删，warn 一次）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ACP_SIDECAR_AUDIT_QUEUE_LIMIT,
  ACP_SIDECAR_DB_FILENAME,
  ACP_SIDECAR_SCHEMA_VERSION,
  ACP_SNAPSHOT_FIELD_MAX,
  ACP_SNAPSHOT_OPTION_LIMIT,
  ACP_SNAPSHOT_TOTAL_BYTES,
  ACP_SNAPSHOT_VALUES_LIMIT,
  acpOptionsSnapshotOf,
  createAcpSidecar,
  installAcpSidecar,
  type AcpBindingData,
  type AcpBindingRecord,
  type AcpOptionsSnapshotRecord,
  type AcpRecoveryState,
  type AcpSidecar,
} from '../../../src/persistence/sidecar.ts'
import { createPermissionAskedAudit, createPermissionDecidedAudit, type AcpPermissionAuditData } from '../../../src/domain/policy/events.ts'

const TIME_BASE = 1_700_000_000_000

/** 全字段 binding 夹具（缺任一必填字段即 outdated——门槛测试按字段删）。 */
function bindingData(overrides: Partial<AcpBindingData> = {}): AcpBindingData {
  return {
    provider: 'acp-devin',
    agentSessionId: 'agent-session-1',
    profileId: 'devin',
    canonicalCwd: '/tmp/work',
    launchFingerprint: { command: 'mock-agent', args: ['--serve'], envKeys: ['MOCK_FLAG'] },
    agent: { name: 'dsh-mock-acp-agent', version: '1.0.0' },
    protocolVersion: 1,
    capabilityHash: 'a1b2c3d4e5f60708',
    configHash: '0817f6e5d4c3b2a1',
    generation: 1,
    bindingEpoch: 1,
    committedPromptOrdinal: 0,
    historyBaseSeq: 0,
    establishedAt: TIME_BASE,
    dshCommittedSeq: 8,
    ...overrides,
  }
}

const BINDING_A: AcpBindingData = bindingData()

const BINDING_B: AcpBindingData = bindingData({
  agentSessionId: 'agent-session-2',
  generation: 2,
  historyBaseSeq: BINDING_A.dshCommittedSeq,
  establishedAt: TIME_BASE + 1,
})

function permissionData(requestId: string) {
  return createPermissionAskedAudit({
    requestId,
    agentSessionId: 'agent-session-1',
    toolCall: { toolCallId: 'tc-1', title: 'Run: echo', kind: 'execute' },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
  })
}

function decidedData(requestId: string) {
  return createPermissionDecidedAudit({
    requestId,
    // decided 去重键的 ACP session / tool call 分量（与 permissionData 同源）
    agentSessionId: 'agent-session-1',
    toolCallId: 'tc-1',
    outcome: 'selected',
    optionId: 'allow_once',
    approvalOutcome: 'allowed-once',
  })
}

let root = ''
let warns: string[] = []
let clock: number
let store: AcpSidecar

function dbFile(): string {
  return path.join(root, ACP_SIDECAR_DB_FILENAME)
}

/** 将生产读模型投影为 envelope，仅供测试断言落库形态。 */
async function readEnvelopes(sessionId: string) {
  return (await store.list(SessionId(sessionId))).map(({ data, ...entry }) => ({ ...entry, payload: data }))
}

/** readLatestBinding 的 ok 臂取值（语义门槛后调用方只在这个臂用 binding）。 */
async function latestBinding(sessionId: string): Promise<AcpBindingRecord | undefined> {
  const lookup = await store.readLatestBinding(SessionId(sessionId))
  return lookup?.status === 'ok' ? lookup.binding : undefined
}

/** 直插 SQL 夹具连接（行级容错/索引表篡改用；用完必须 close）。 */
function rawDb(): DatabaseSync {
  return new DatabaseSync(dbFile())
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-sidecar-spec-'))
  warns = []
  clock = TIME_BASE
  store = createAcpSidecar({
    root,
    now: () => {
      clock += 1
      return clock
    },
    warn: (message) => warns.push(message),
  })
})

afterEach(async () => {
  await store.dispose().catch(() => undefined)
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('createAcpSidecar 基本读写（v2 envelope 契约）', () => {
  it('dispatch uncertainty is durable across reopen and settles idempotently', async () => {
    await store.beginDispatch({
      key: 'step-1', dshSessionId: 'sess-dispatch', provider: 'acp-devin', model: 'm',
      state: 'dispatch-uncertain', createdAt: TIME_BASE,
    })
    await store.dispose()
    store = createAcpSidecar({ root, now: () => TIME_BASE + 1 })
    await expect(store.readDispatch(SessionId('sess-dispatch'), 'step-1')).resolves.toMatchObject({ state: 'dispatch-uncertain' })
    await expect(store.beginDispatch({
      key: 'step-1', dshSessionId: 'sess-dispatch', provider: 'acp-devin', model: 'm',
      state: 'dispatch-uncertain', createdAt: TIME_BASE,
    })).rejects.toThrow('ACP_RECOVERY_REQUIRED')
    await store.settleDispatch(SessionId('sess-dispatch'), 'step-1')
    await store.settleDispatch(SessionId('sess-dispatch'), 'step-1')
    await expect(store.readDispatch(SessionId('sess-dispatch'), 'step-1')).resolves.toMatchObject({ state: 'settled' })
  })

  it('keeps at most one settled dispatch row per DSH session', async () => {
    for (let index = 0; index < 100; index += 1) {
      const key = `step-${index}`
      await store.beginDispatch({ key, dshSessionId: 'sess-bounded', provider: 'acp-devin', model: 'm', state: 'dispatch-uncertain', createdAt: TIME_BASE + index })
      await store.settleDispatch(SessionId('sess-bounded'), key)
    }
    const db = (store as unknown as { db?: { prepare(sql: string): { get(...args: unknown[]): unknown } } }).db
    expect(db?.prepare('SELECT COUNT(*) AS n FROM dispatch_ledger WHERE dsh_session_id = ?').get('sess-bounded')).toEqual({ n: 1 })
  })

  it('recovery state is durable and independent from the audit stream', async () => {
    const state: AcpRecoveryState = {
      dshSessionId: 'sess-1',
      kind: 'outcome-unknown',
      cause: 'prompt-timeout',
      detail: 'remote outcome was not confirmed',
      provider: 'acp-devin',
      acpSessionId: 'agent-session-1',
      generation: 1,
      interruptedTurnId: '3',
      updatedAt: TIME_BASE,
    }
    await store.writeRecoveryState(state)
    await store.dispose()
    store = createAcpSidecar({ root, now: () => TIME_BASE + 1 })
    await expect(store.readRecoveryState(SessionId('sess-1'))).resolves.toEqual(state)
    await expect(store.readRecoveryState(SessionId('missing'))).resolves.toBeUndefined()
  })
  it('recovery schema migrates legacy current-state rows', async () => {
    const legacy = new DatabaseSync(dbFile())
    legacy.exec('CREATE TABLE recovery_states (dsh_session_id TEXT PRIMARY KEY, time INTEGER NOT NULL, payload TEXT NOT NULL) STRICT')
    legacy.close()
    const state: AcpRecoveryState = {
      dshSessionId: 'sess-legacy',
      kind: 'reconnect-required',
      cause: 'load-failed',
      detail: 'retry the original session',
      updatedAt: TIME_BASE + 2,
      lastAttemptAt: TIME_BASE + 2,
      lastUserAction: 'retry-original',
    }
    await store.writeRecoveryState(state)
    await expect(store.readRecoveryState(SessionId('sess-legacy'))).resolves.toEqual(state)
    const inspection = new DatabaseSync(dbFile())
    try {
      const columns = inspection.prepare('PRAGMA table_info(recovery_states)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['last_attempt_at', 'last_user_action']))
    } finally {
      inspection.close()
    }
  })
  it('malformed recovery state fails loudly instead of becoming an empty/healthy read', async () => {
    await store.writeRecoveryState({ dshSessionId: 'sess-1', kind: 'outcome-unknown', updatedAt: TIME_BASE })
    const db = rawDb()
    try {
      db.prepare('UPDATE recovery_states SET payload = ? WHERE dsh_session_id = ?').run('{"kind":', 'sess-1')
    } finally {
      db.close()
    }
    await expect(store.readRecoveryState(SessionId('sess-1'))).rejects.toThrow('local recovery history is damaged')
  })
  it('append 落库：list 逐行重建 v2 envelope（schemaVersion/recordId/seq/time/kind/dshSessionId/acp*/payload 逐字段）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_A })
    const lines = await readEnvelopes('sess-1')
    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line?.schemaVersion).toBe(ACP_SIDECAR_SCHEMA_VERSION)
    expect(line?.kind).toBe('binding')
    expect(line?.time).toBe(TIME_BASE + 1) // time 缺省由 store 时钟补齐
    expect(line?.seq).toBe(1)
    expect(line?.recordId).toMatch(/^h:[0-9a-f]{16}$/)
    expect(line?.dshSessionId).toBe('sess-1')
    // binding 的 acp 身份自 payload 推导（恒有）
    expect(line?.acpProviderId).toBe('acp-devin')
    expect(line?.acpSessionId).toBe('agent-session-1')
    expect(line?.payload).toEqual(BINDING_A)
  })

  it('permission envelope：asked/decided 均推导 acpSessionId；decided 的 recordId = decided:<agentSessionId>:<toolCallId>:<requestId>（去重键）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data: decidedData('req-1') })
    const [asked, decided] = await readEnvelopes('sess-1')
    expect(asked?.seq).toBe(1)
    expect(asked?.acpSessionId).toBe('agent-session-1')
    expect(asked && 'acpProviderId' in asked).toBe(false) // asked 载荷无 provider，如实缺省
    expect(decided?.seq).toBe(2)
    expect(decided?.recordId).toBe('decided:agent-session-1:tc-1:req-1')
    expect(decided?.acpSessionId).toBe('agent-session-1') // decided 载荷也带 ACP 身份
    expect(decided?.payload).toEqual(decidedData('req-1'))
  })

  it('旧 permission JSON 缺少集合计数字段仍可 list/export，且不把旧记录伪装成完整集合', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: permissionData('legacy-req') })
    const db = rawDb()
    try {
      const row = db.prepare('SELECT payload FROM audit WHERE dsh_session_id = ?').get('sess-1') as { payload: string }
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      delete payload.optionCount
      delete payload.omittedOptionCount
      delete payload.locationCount
      delete payload.omittedLocationCount
      db.prepare('UPDATE audit SET payload = ? WHERE dsh_session_id = ?').run(JSON.stringify(payload), 'sess-1')
    } finally {
      db.close()
    }
    const listed = await store.list(SessionId('sess-1'))
    const asked = listed[0]?.data as AcpPermissionAuditData
    expect(asked).not.toHaveProperty('optionCount')
    expect(asked).not.toHaveProperty('omittedOptionCount')
    const exported = (await readEnvelopes('sess-1'))[0]
    expect(exported?.payload).not.toHaveProperty('optionCount')
    expect(exported?.payload).not.toHaveProperty('omittedOptionCount')
  })

  it('显式 time 原样保留（permissions 桥注入时钟的确定性路径）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 42, data: permissionData('req-1') })
    const line = (await readEnvelopes('sess-1'))[0]
    expect(line?.time).toBe(42)
    expect(line?.kind).toBe('permission')
  })

  it('seq per session 单调递增（连续 append 1..N）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 3, data: decidedData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 4, data: BINDING_B })
    expect((await readEnvelopes('sess-1')).map((line) => line.seq)).toEqual([1, 2, 3, 4])
  })

  it('recordId 稳定唯一：内容哈希派生，同 session 内撞名追加 -2 序号', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A }) // 逐字节相同 → 撞名
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 11, data: BINDING_A })
    const ids = (await readEnvelopes('sess-1')).map((line) => line.recordId)
    expect(ids[0]).toMatch(/^h:[0-9a-f]{16}$/)
    expect(ids[1]).toBe(`${ids[0]}-2`)
    expect(ids[2]).not.toBe(ids[0])
    expect(new Set(ids).size).toBe(3)
  })

  it('list 按追加序返回全部合法 entry（统一读取模型：kind/time/data 访问器不变 + envelope 字段）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 50, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_B })
    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['binding', 'permission', 'binding'])
    expect(entries.map((entry) => entry.time)).toEqual([TIME_BASE + 1, 50, TIME_BASE + 2])
    expect(entries.map((entry) => entry.schemaVersion)).toEqual([2, 2, 2])
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(entries[1]?.data).toEqual(permissionData('req-1'))
    expect(entries[0]?.dshSessionId).toBe('sess-1')
    expect(typeof entries[0]?.recordId).toBe('string')
  })

  it('listPage 使用 session 内 seq 游标稳定分页且不串入其他会话', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.append(SessionId('sess-2'), { kind: 'binding', time: 2, data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 3, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 4, data: BINDING_B })

    const first = await store.listPage(SessionId('sess-1'), 0, 2)
    const second = await store.listPage(SessionId('sess-1'), first.at(-1)?.seq ?? 0, 2)
    expect(first.map((entry) => entry.seq)).toEqual([1, 2])
    expect(second.map((entry) => entry.seq)).toEqual([3])
    expect([...first, ...second].every((entry) => entry.dshSessionId === 'sess-1')).toBe(true)
    expect(() => store.listPage(SessionId('sess-1'), -1, 2)).toThrow('cursor')
    expect(() => store.listPage(SessionId('sess-1'), 0, 101)).toThrow('page size')
  })

  it('readLatestBinding 返回最新一条 binding（ok 臂：含落库 time）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 20, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 30, data: BINDING_B })
    const lookup = await store.readLatestBinding(SessionId('sess-1'))
    expect(lookup?.status).toBe('ok')
    const record = lookup?.status === 'ok' ? lookup.binding : undefined
    expect(record?.time).toBe(30)
    expect(record?.provider).toBe('acp-devin')
    expect(record?.agentSessionId).toBe('agent-session-2')
    // permission entry 不干扰 binding 读取
    expect((await latestBinding('sess-1'))?.agentSessionId).toBe('agent-session-2')
  })

  it('不同 sessionId 各自独立行集（共享单库；目录不出现按 session 分文件）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_A })
    await store.append(SessionId('sess-2'), { kind: 'binding', data: BINDING_B })
    expect((await latestBinding('sess-1'))?.agentSessionId).toBe('agent-session-1')
    expect((await latestBinding('sess-2'))?.agentSessionId).toBe('agent-session-2')
    expect((await store.list(SessionId('sess-1'))).map((entry) => entry.dshSessionId)).toEqual(['sess-1'])
    // 单库形态：目录里只有 sidecar.sqlite 及其 WAL 旁生，没有 per-session .jsonl
    for (const name of fs.readdirSync(root)) {
      expect(name.startsWith(ACP_SIDECAR_DB_FILENAME)).toBe(true)
    }
    expect(fs.existsSync(dbFile())).toBe(true)
  })

  it('库不存在：readLatestBinding → undefined，list → []，且不建库（读路径零副作用）', async () => {
    expect(await store.readLatestBinding(SessionId('ghost'))).toBeUndefined()
    expect(await store.list(SessionId('ghost'))).toEqual([])
    expect(fs.existsSync(dbFile())).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('append 成功后目录无临时文件/旁生隔离文件残留（无 .tmp/.jsonl/.corrupt-*）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_B })
    const names = fs.readdirSync(root)
    expect(names.every((name) => name === ACP_SIDECAR_DB_FILENAME || name === `${ACP_SIDECAR_DB_FILENAME}-wal` || name === `${ACP_SIDECAR_DB_FILENAME}-shm`)).toBe(true)
  })

  it('同一 sessionId 并发 append 全部完好落库：seq 独占 1..N 不交错（同步路径天然串行）', async () => {
    const count = 20
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.append(SessionId('sess-1'), {
          kind: 'permission',
          time: index,
          data: permissionData(`req-${String(index)}`),
        })),
    )
    const lines = await readEnvelopes('sess-1')
    expect(lines).toHaveLength(count)
    const times = lines.map((line) => line.time).sort((a, b) => a - b)
    expect(times).toEqual(Array.from({ length: count }, (_, index) => index))
    expect(lines.map((line) => line.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    expect(new Set(lines.map((line) => line.recordId)).size).toBe(count)
  })
})

describe(' binding 语义门槛（readLatestBinding 三态）', () => {
  it('已有合法 binding 时拒绝畸形覆盖，索引与 audit 同事务保持不变', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
    await expect(store.append(SessionId('sess-1'), {
      kind: 'binding',
      time: 20,
      data: { provider: 'acp-devin', agentSessionId: 'agent-session-9' } as unknown as AcpBindingData,
    })).rejects.toThrow('invalid binding')
    expect((await latestBinding('sess-1'))?.agentSessionId).toBe('agent-session-1')
    expect(await readEnvelopes('sess-1')).toHaveLength(1)
  })

  it('跨 provider、同代换 Agent session、generation 跳跃均拒绝且不污染原 binding', async () => {
    await store.append(SessionId('sess-cas'), { kind: 'binding', time: 10, data: BINDING_A })
    const invalid = [
      bindingData({ provider: 'acp-codex', profileId: 'codex' }),
      bindingData({ agentSessionId: 'other-session' }),
      bindingData({ agentSessionId: 'future-session', generation: 3, historyBaseSeq: 8, establishedAt: TIME_BASE + 1 }),
    ]
    for (const [index, data] of invalid.entries()) {
      await expect(store.append(SessionId('sess-cas'), { kind: 'binding', time: 20 + index, data })).rejects.toThrow()
    }
    expect((await latestBinding('sess-cas'))?.agentSessionId).toBe(BINDING_A.agentSessionId)
    expect(await readEnvelopes('sess-cas')).toHaveLength(1)
  })

  it('语义门槛逐字段钉版：删任一必填字段即 outdated', async () => {
    const required = [
      'provider', 'agentSessionId', 'profileId', 'canonicalCwd', 'launchFingerprint',
      'agent', 'protocolVersion', 'capabilityHash', 'configHash', 'generation',
      'historyBaseSeq', 'establishedAt', 'dshCommittedSeq',
    ] as const
    for (const field of required) {
      const payload: Record<string, unknown> = { ...BINDING_A }
      delete payload[field]
      const id = `sess-miss-${field}`
      await store.append(SessionId(id), { kind: 'binding', time: 10, data: payload as unknown as AcpBindingData })
      expect(await store.readLatestBinding(SessionId(id)), `missing ${field}`).toEqual({ status: 'outdated' })
    }
  })

  it('字段形态违例即 outdated（generation 非正整数 / envKeys 含非字符串 / configHash 空串等）', async () => {
    const badPayloads: Record<string, unknown>[] = [
      { ...BINDING_A, generation: 0 },
      { ...BINDING_A, generation: 1.5 },
      { ...BINDING_A, historyBaseSeq: -1 },
      { ...BINDING_A, dshCommittedSeq: -1 },
      { ...BINDING_A, protocolVersion: Number.NaN },
      { ...BINDING_A, capabilityHash: '' },
      { ...BINDING_A, launchFingerprint: { command: 'mock-agent', args: ['--serve'], envKeys: ['OK', 42] } },
      { ...BINDING_A, launchFingerprint: { command: '', args: [], envKeys: [] } },
      { ...BINDING_A, agent: { name: 42 } },
    ]
    for (const [index, payload] of badPayloads.entries()) {
      const id = `sess-bad-${String(index)}`
      await store.append(SessionId(id), { kind: 'binding', time: 10, data: payload as unknown as AcpBindingData })
      expect(await store.readLatestBinding(SessionId(id)), JSON.stringify(payload)).toEqual({ status: 'outdated' })
    }
  })

  it('audit 表的游离非法行不参与 binding 判定（bindings 索引独立；坏行跳过 + warn）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
    // 经第二个连接直插一行 kind=binding 但 payload 非 JSON 的游离 audit 行
    //（模拟库外篡改/旧版残留——bindings 索引不受影响，list 跳过 + warn）
    const raw = rawDb()
    raw.prepare('INSERT INTO audit (record_id, dsh_session_id, seq, time, kind, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run('r-bad', 'sess-1', 99, 20, 'binding', 'not-json{')
    raw.close()
    const lookup = await store.readLatestBinding(SessionId('sess-1'))
    expect(lookup?.status).toBe('ok')
    expect(lookup?.status === 'ok' && lookup.binding.agentSessionId).toBe('agent-session-1')
    const entries = await store.list(SessionId('sess-1'))
    expect(entries).toHaveLength(1)
    expect(warns.some((message) => message.includes('skipped 1 malformed audit row(s)'))).toBe(true)
  })

  it('纯 permission 行集（无 binding 行）→ undefined（与 outdated 明确区分）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: permissionData('req-1') })
    expect(await store.readLatestBinding(SessionId('sess-1'))).toBeUndefined()
  })
})

describe('degradation kind', () => {
  it('append/list 往返：payload 原样读回、acp 身份字段不编造、不参与 decided 去重', async () => {
    await store.append(SessionId('sess-1'), {
      kind: 'degradation',
      time: 1,
      data: {
        code: 'unsupported-tool-content',
        toolCallId: 'tc-1',
        items: [
          { type: 'image', reason: 'v1 无附件 seam，字节不落盘', originalSize: 128 },
          { type: 'diff', reason: '摘要落盘，预览超界截断', originalSize: 9_999 },
        ],
        keptPreviewChars: 4_096,
        truncated: true,
      },
    })
    await store.append(SessionId('sess-1'), {
      kind: 'degradation',
      time: 2,
      data: {
        code: 'unsupported-chunk-content',
        items: [{ type: 'image', reason: '消息 chunk 的非文本块仍不翻译' }],
        keptPreviewChars: 0,
        truncated: false,
      },
    })
    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['degradation', 'degradation'])
    expect(entries[0]?.data).toEqual({
      code: 'unsupported-tool-content',
      toolCallId: 'tc-1',
      items: [
        { type: 'image', reason: 'v1 无附件 seam，字节不落盘', originalSize: 128 },
        { type: 'diff', reason: '摘要落盘，预览超界截断', originalSize: 9_999 },
      ],
      keptPreviewChars: 4_096,
      truncated: true,
    })
    expect(entries[1]?.data).toEqual({
      code: 'unsupported-chunk-content',
      items: [{ type: 'image', reason: '消息 chunk 的非文本块仍不翻译' }],
      keptPreviewChars: 0,
      truncated: false,
    })
    const [first] = await readEnvelopes('sess-1')
    // degradation payload 无 acp 身份可推导（恒缺省，不编造）
    expect(first && 'acpProviderId' in first).toBe(false)
    expect(first && 'acpSessionId' in first).toBe(false)
    expect(await store.readLatestBinding(SessionId('sess-1'))).toBeUndefined()
  })
})

describe('reconciliation kind', () => {
  it('append/list 往返：acpSessionId 在场时推导到 envelope，acpProviderId 不编造', async () => {
    await store.append(SessionId('sess-1'), {
      kind: 'reconciliation',
      time: 1,
      data: { cause: 'replay-diverged', detail: 'first divergence at index 2', acpSessionId: 'agent-session-1', generation: 1 },
    })
    await store.append(SessionId('sess-1'), {
      kind: 'reconciliation',
      time: 2,
      data: { cause: 'binding-missing' },
    })
    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['reconciliation', 'reconciliation'])
    expect(entries[0]?.data).toEqual({ cause: 'replay-diverged', detail: 'first divergence at index 2', acpSessionId: 'agent-session-1', generation: 1 })
    expect(entries[1]?.data).toEqual({ cause: 'binding-missing' })
    const [first, second] = await readEnvelopes('sess-1')
    expect(first?.acpSessionId).toBe('agent-session-1')
    expect(first && 'acpProviderId' in first).toBe(false)
    expect(second && 'acpSessionId' in second).toBe(false) // 无 acpSessionId 可推导，如实缺省
    // reconciliation 不参与 decided 去重，也不进 binding 索引
    expect(await store.readLatestBinding(SessionId('sess-1'))).toBeUndefined()
  })
})

describe('permission decided 重连重放去重（/ dedupe_key）', () => {
  it('同 requestId 的 decided 第二次落库被跳过（行集不变，append 正常 resolve）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data: decidedData('req-1') })
    // 重连重放：同 requestId 的 decided 再写一次
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 3, data: decidedData('req-1') })
    const lines = await readEnvelopes('sess-1')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.seq)).toEqual([1, 2])
  })

  it('不同 requestId 的 decided 照常落库；asked 不去重（重放是真实事件，审计如实各落一条）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: decidedData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data: decidedData('req-2') })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 3, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 4, data: permissionData('req-1') })
    const entries = await store.list(SessionId('sess-1'))
    const permissions = entries.filter((entry) => entry.kind === 'permission')
    expect(permissions.map((entry) => entry.data.phase)).toEqual(['decided', 'decided', 'asked', 'asked'])
    const ids = (await readEnvelopes('sess-1')).map((line) => line.recordId)
    expect(ids.slice(0, 2)).toEqual(['decided:agent-session-1:tc-1:req-1', 'decided:agent-session-1:tc-1:req-2'])
    expect(ids[2]).toMatch(/^h:/)
    expect(ids[3]).toMatch(/^h:/)
    expect(ids[2]).not.toBe(ids[3])
  })

  it('去重键三分量：同 requestId 但不同 toolCallId 的 decided 不被去重（不同决定）', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: decidedData('req-1') })
    await store.append(SessionId('sess-1'), {
      kind: 'permission',
      time: 2,
      data: createPermissionDecidedAudit({
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        toolCallId: 'tc-2', // 同 requestId 不同 tool call——不是同一决定的重放
        outcome: 'cancelled',
        note: 'cancelled',
      }),
    })
    expect(await readEnvelopes('sess-1')).toHaveLength(2)
  })

  it('去重键缺分量的 decided 不参与去重（无法证明同一决定，宁多落一条也不丢审计）', async () => {
    const { agentSessionId: _a, toolCallId: _t, ...legacy } = decidedData('req-9')
    const data = legacy as unknown as AcpPermissionAuditData
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data })
    const lines = await readEnvelopes('sess-1')
    expect(lines).toHaveLength(2)
    // recordId 退化为内容哈希（无 decided: 前缀键可派生）
    expect(lines.every((line) => line.recordId.startsWith('h:'))).toBe(true)
  })

  it('去重键按 session 维度隔离：另一 session 的同键 decided 照常落库', async () => {
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: decidedData('req-1') })
    await store.append(SessionId('sess-2'), { kind: 'permission', time: 2, data: decidedData('req-1') })
    expect(await readEnvelopes('sess-1')).toHaveLength(1)
    expect(await readEnvelopes('sess-2')).toHaveLength(1)
  })
})

describe('行级容错与库级 fail loud（坏行/隔离概念删除后的等价门槛）', () => {
  it('直插 SQL 的非法 audit 行：跳过并 warn 计数；合法行照常读出', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
    const raw = rawDb()
    const insert = raw.prepare('INSERT INTO audit (record_id, dsh_session_id, seq, time, kind, payload) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('r-bad-1', 'sess-1', 90, 1, 'unknown-kind', '{}') // 未知 kind
    insert.run('r-bad-2', 'sess-1', 91, 1, 'binding', 'not-json{') // 坏 JSON
    insert.run('r-bad-3', 'sess-1', 0, 1, 'binding', '{}') // seq 非正整数
    insert.run('r-bad-4', 'sess-1', 92, 1, 'binding', '[1,2]') // payload 非对象
    insert.run('', 'sess-1', 93, 1, 'binding', '{}') // 空 recordId
    raw.close()

    const entries = await store.list(SessionId('sess-1'))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('binding')
    expect(entries[0]?.data).toEqual(BINDING_A)
    expect(warns.some((message) => message.includes('skipped 5 malformed audit row(s)'))).toBe(true)
  })

  it('库文件损坏 → open 即 fail loud（warn + reject），不再吞错降级', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.dispose()
    fs.writeFileSync(dbFile(), 'this is not a sqlite database at all, just garbage bytes\n', 'utf8')
    const broken = createAcpSidecar({ root, warn: (message) => warns.push(message) })
    await expect(broken.list(SessionId('sess-1'))).rejects.toThrow()
    await expect(broken.append(SessionId('sess-1'), { kind: 'binding', time: 2, data: BINDING_A })).rejects.toThrow()
    expect(warns.some((message) => message.includes('fails loud'))).toBe(true)
  })

})

describe('listBindings 全量 binding 索引（双绑守卫扫描面）', () => {
  it('取全部 session 的最新合法 binding；无 binding 的行集不出现', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 15, data: permissionData('req-1') })
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 20, data: BINDING_B })
    await store.append(SessionId('sess-2'), { kind: 'binding', time: 30, data: BINDING_A })
    // 无 binding 记录的行集（纯 permission）不出现在索引里
    await store.append(SessionId('sess-3'), { kind: 'permission', time: 40, data: permissionData('req-2') })

    const bindings = await store.listBindings()
    expect(bindings.map((entry) => entry.dshSessionId).sort()).toEqual(['sess-1', 'sess-2'])
    // 最新优先：sess-1 的最新 binding 是 BINDING_B（permission 行不干扰）
    const first = bindings.find((entry) => entry.dshSessionId === 'sess-1')
    expect(first?.binding.agentSessionId).toBe('agent-session-2')
    expect(first?.binding.time).toBe(20)
    const second = bindings.find((entry) => entry.dshSessionId === 'sess-2')
    expect(second?.binding.agentSessionId).toBe('agent-session-1')
    expect(second?.binding.time).toBe(30)
  })

  it('outdated binding 的行集不进索引（语义门槛与 readLatestBinding 同源）', async () => {
    await store.append(SessionId('sess-1'), {
      kind: 'binding',
      time: 20,
      data: { provider: 'acp-devin', agentSessionId: 'agent-session-9' } as unknown as AcpBindingData,
    })
    expect(await store.listBindings()).toEqual([])
    expect(warns.some((message) => message.includes('outdated binding row(s)'))).toBe(true)
  })

  it('只读容错：root/库不存在 → []', async () => {
    const missing = createAcpSidecar({ root: path.join(root, 'missing'), warn: (message) => warns.push(message) })
    expect(await missing.listBindings()).toEqual([])
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false)
  })
})

describe('有界审计队列 + flush（有界审计队列）', () => {
  it('非审批 kind 入队：append 返回时不阻塞（未 flush 前库里查无此行）；flush 落齐', async () => {
    // 不 await：append 的同步段只入队（不展开 microtask drain）
    void store.append(SessionId('sess-1'), { kind: 'degradation', time: 1, data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false } })
    const raw = rawDb()
    const count = raw.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }
    raw.close()
    expect(count.n).toBe(0)
    await store.flush()
    expect(await store.list(SessionId('sess-1'))).toHaveLength(1)
  })

  it('binding/permission 走同步 durable 路径：append 调用返回前已落库（不经过队列）', async () => {
    void store.append(SessionId('sess-1'), { kind: 'permission', time: 1, data: permissionData('req-1') })
    void store.append(SessionId('sess-1'), { kind: 'binding', time: 2, data: BINDING_A })
    // 未经任何 await（队列 drain 的 microtask 不会跑），直查库即见
    const raw = rawDb()
    const rows = raw.prepare('SELECT kind FROM audit ORDER BY seq ASC').all() as { kind: string }[]
    const binding = raw.prepare('SELECT payload FROM bindings WHERE dsh_session_id = ?').get('sess-1') as { payload: string } | undefined
    raw.close()
    expect(rows.map((row) => row.kind)).toEqual(['permission', 'binding'])
    expect(binding).toBeDefined()
  })

  it('filesystem 审计在 append 返回前已 durable，避免文件副作用与审计脱节', async () => {
    const pending = store.append(SessionId('sess-1'), {
      kind: 'filesystem',
      time: 3,
      data: {
        operation: 'write', path: '/tmp/a.txt', bytes: 3,
        beforeHash: null, afterHash: 'abc', outcome: 'ok',
        acpSessionId: 'agent-session-1', profileId: 'devin',
      },
    })
    const raw = rawDb()
    const row = raw.prepare('SELECT kind FROM audit WHERE dsh_session_id = ?').get('sess-1') as { kind: string } | undefined
    raw.close()
    expect(row?.kind).toBe('filesystem')
    await pending
  })

  it('队列满 → 丢弃新记录并 warn 计数（绝不阻塞）', async () => {
    const limited = createAcpSidecar({ root, now: () => ++clock, warn: (message) => warns.push(message), queueLimit: 4 })
    for (let index = 0; index < 6; index += 1) {
      void limited.append(SessionId('sess-1'), { kind: 'degradation', time: index, data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false } })
    }
    await limited.flush()
    expect(await limited.list(SessionId('sess-1'))).toHaveLength(4)
    expect(warns.some((message) => message.includes('audit queue is full (limit 4)'))).toBe(true)
  })

  it('默认队列上限常量导出（1024）', () => {
    expect(ACP_SIDECAR_AUDIT_QUEUE_LIMIT).toBe(1024)
  })

  it('队列批量落库保持追加序：混合排队 kind 的 seq 单调、读回顺序与 append 序一致', async () => {
    for (let index = 0; index < 50; index += 1) {
      await store.append(SessionId('sess-1'), { kind: 'reconciliation', time: index, data: { cause: 'binding-missing', acpSessionId: `agent-${String(index)}` } })
    }
    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    expect(entries.map((entry) => entry.time)).toEqual(Array.from({ length: 50 }, (_, index) => index))
  })

  it('队列批量落库失败 → 整批丢弃 + warn + droppedEntries 计数；故障恢复后照写照读', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.flush()
    // 制造落库失败：经第二个连接装一个 INSERT 拦截触发器（drain 事务的 INSERT 必抛；
    // chmod 只读对已打开的 fd 无效，故用库内触发器注入）
    const raw = rawDb()
    raw.exec("CREATE TRIGGER audit_block BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END")
    raw.close()
    try {
      void store.append(SessionId('sess-1'), { kind: 'degradation', time: 2, data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false } })
      await store.flush() // drain 失败：整批丢弃（warn），flush 不因维护性 checkpoint 失败拒绝
    } finally {
      const restore = rawDb()
      restore.exec('DROP TRIGGER audit_block')
      restore.close()
    }
    expect(warns.some((message) => message.includes('failed to flush 1 queued audit record(s)'))).toBe(true)
    expect(warns.some((message) => message.includes('injected insert failure'))).toBe(true)
    // 触发器拆除后：照写照读（丢弃的非审批审计不毒化后续）
    await store.append(SessionId('sess-1'), { kind: 'degradation', time: 3, data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false } })
    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['binding', 'degradation'])
  })
})

describe('权限位（目录 0700 / 库与 wal/shm 0600）', () => {
  it('append 后 root 0700、sidecar.sqlite 0600、wal/shm 0600', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    if (process.platform === 'win32') {
      // Windows ACLs are not represented by POSIX mode bits. The product
      // contract here is that the private database is created successfully.
      expect(fs.existsSync(dbFile())).toBe(true)
      return
    }
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
    expect(fs.statSync(dbFile()).mode & 0o777).toBe(0o600)
    const wal = `${dbFile()}-wal`
    const shm = `${dbFile()}-shm`
    // WAL 旁生文件在首批写后存在（未 checkpoint 关闭前）；存在即须 0600
    if (fs.existsSync(wal)) expect(fs.statSync(wal).mode & 0o777).toBe(0o600)
    if (fs.existsSync(shm)) expect(fs.statSync(shm).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(wal)).toBe(true)
    expect(fs.existsSync(shm)).toBe(true)
    await store.flush()
    if (fs.existsSync(wal)) expect(fs.statSync(wal).mode & 0o777).toBe(0o600)
    if (fs.existsSync(shm)) expect(fs.statSync(shm).mode & 0o777).toBe(0o600)
  })
})

describe('旧 JSONL 残留（不做迁移层，一律忽略）', () => {
  it('root 下旧 *.jsonl 不读不迁不删：写库正常、旧文件字节不动、warn 一次', async () => {
    const legacy = path.join(root, 'sess-legacy.jsonl')
    const legacyContent = '{"schemaVersion":2,"recordId":"r-1","seq":1,"time":1,"kind":"binding","dshSessionId":"sess-legacy","payload":{}}\n'
    fs.writeFileSync(legacy, legacyContent, 'utf8')
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    // 旧文件原样保留，内容不被读取（sess-legacy 在库里查无行）
    expect(fs.readFileSync(legacy, 'utf8')).toBe(legacyContent)
    expect(await store.list(SessionId('sess-legacy'))).toEqual([])
    expect(await store.readLatestBinding(SessionId('sess-legacy'))).toBeUndefined()
    const legacyWarns = warns.filter((message) => message.includes('legacy JSONL'))
    expect(legacyWarns).toHaveLength(1)
    // 再次写不再重复 warn
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data: permissionData('req-1') })
    expect(warns.filter((message) => message.includes('legacy JSONL'))).toHaveLength(1)
  })
})

describe('性能快速回归', () => {
  it('10k 同步 append 在预算内完成并保持完整顺序', async () => {
    const N = 10_000
    const started = performance.now()
    const marks: number[] = []
    for (let index = 0; index < N; index += 1) {
      await store.append(SessionId('sess-bench'), { kind: 'permission', time: index + 1, data: permissionData(`req-${String(index)}`) })
      if ((index + 1) % 1_000 === 0) marks.push(performance.now() - started)
    }
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(10_000)
    const first = marks[0] ?? 0
    const last = (marks[9] ?? 0) - (marks[8] ?? 0)
    expect(first).toBeGreaterThan(0)
    expect(last).toBeLessThan(first * 5)
    const db = rawDb()
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit').get()).toEqual({ n: N })
    expect(db.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    db.close()
    const entries = await store.list(SessionId('sess-bench'))
    expect(entries).toHaveLength(N)
    expect(entries[0]?.seq).toBe(1)
    expect(entries[N - 1]?.seq).toBe(N)
  }, 30_000)
})

describe('createAcpSidecar 行键安全边界', () => {
  it('非法 sessionId 一律同步抛 TypeError（append/list/readLatestBinding）', () => {
    const illegal = ['../escape', '..', '.', 'a/b', 'a\\b', '', 'with space']
    for (const id of illegal) {
      expect(() => store.append(SessionId(id), { kind: 'binding', data: BINDING_A })).toThrow(TypeError)
      expect(() => store.list(SessionId(id))).toThrow(TypeError)
      expect(() => store.readLatestBinding(SessionId(id))).toThrow(TypeError)
    }
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('ULID 风格与点号/连字符 id 合法', async () => {
    await store.append(SessionId('01J4Z5Y6.example_test-1'), { kind: 'binding', data: BINDING_A })
    expect(await store.list(SessionId('01J4Z5Y6.example_test-1'))).toHaveLength(1)
  })
})

describe('installAcpSidecar', () => {
 it('dshHomePath slot 缺席 → undefined（起由 createAcpMachine fail loud 拒启 ACP 会话；不写真实 ~/.dsh）', () => {
    const ctx = new Context()
    expect(installAcpSidecar(ctx)).toBeUndefined()
  })

  it('dshHomePath slot 存在 → root 选址 <home>/dsh-acp 且读写可用（实证 provide/get 往返，落库即 v2 可读回）', async () => {
    const ctx = new Context()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-sidecar-home-'))
    try {
      ctx.provide('dshHomePath', (...segments: string[]) => path.join(home, ...segments))
      const installed = installAcpSidecar(ctx)
      expect(installed).toBeDefined()
      expect(installed?.root).toBe(path.join(home, 'dsh-acp'))
      await installed?.append(SessionId('sess-9'), { kind: 'binding', time: 1, data: BINDING_A })
      // 单库选址契约：<home>/dsh-acp/sidecar.sqlite
      expect(fs.existsSync(path.join(home, 'dsh-acp', ACP_SIDECAR_DB_FILENAME))).toBe(true)
      expect(await installed?.list(SessionId('sess-9'))).toHaveLength(1)
      const lookup = await installed?.readLatestBinding(SessionId('sess-9'))
      expect(lookup?.status).toBe('ok')
      expect(lookup?.status === 'ok' && lookup.binding.agentSessionId).toBe('agent-session-1')
      await installed?.dispose()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})


// ---------- last-known option 快照（option_snapshots 表 + acpOptionsSnapshotOf） ----------

describe(' option 快照（acpOptionsSnapshotOf 有界标准化 + option_snapshots 表）', () => {
  it('往返：select 拍平 values（含分组）/boolean values 归 null；_meta/description 不持久化', async () => {
    const record = acpOptionsSnapshotOf(
      [
        {
          type: 'select',
          id: 'model',
          category: 'model',
          name: 'Model',
          currentValue: 'm1',
          options: [
            { value: 'm1', name: 'M1' },
            { name: 'Group', options: [{ value: 'm2', name: 'M2' }] },
          ],
          _meta: { huge: 'x'.repeat(4000) },
        } as never,
        { type: 'boolean', id: 'fast', name: 'Fast', currentValue: true } as never,
        // 未知 type（协议 SHOULD-ignore 口径：跳过不持久化）
        { type: 'slider', id: 'temperature', name: 'Temperature', currentValue: 'low' } as never,
      ],
      'code',
      'fp-1',
      TIME_BASE,
    )
    expect(record).toEqual({
      options: [
        { id: 'model', category: 'model', name: 'Model', value: 'm1', values: ['m1', 'm2'] },
        { id: 'fast', category: null, name: 'Fast', value: true, values: null },
      ],
      currentModeId: 'code',
      updatedAt: TIME_BASE,
      fingerprint: 'fp-1',
    })
    await store.writeOptionSnapshot(SessionId('sess-1'), record)
    expect(await store.readOptionSnapshot(SessionId('sess-1'))).toEqual(record)
    // 无行 → undefined
    expect(await store.readOptionSnapshot(SessionId('ghost'))).toBeUndefined()
  })

  it('硬上限：字段截断 128 字符、values 截断 64 条、选项数截断 32 项', () => {
    const longId = 'x'.repeat(ACP_SNAPSHOT_FIELD_MAX + 50)
    const manyValues = Array.from({ length: ACP_SNAPSHOT_VALUES_LIMIT + 10 }, (_, index) => ({ value: `v${String(index)}`, name: `v${String(index)}` }))
    const manyOptions = Array.from({ length: ACP_SNAPSHOT_OPTION_LIMIT + 5 }, (_, index) => ({
      type: 'boolean',
      id: `opt-${String(index)}`,
      name: `opt-${String(index)}`,
      currentValue: false,
    }))
    const record = acpOptionsSnapshotOf(
      [{ type: 'select', id: longId, name: 'Model', currentValue: 'm1', options: manyValues } as never, ...(manyOptions as never[])],
      undefined,
      'fp-2',
      TIME_BASE,
    )
    expect(record.options).toHaveLength(ACP_SNAPSHOT_OPTION_LIMIT)
    expect(record.options[0]?.id).toHaveLength(ACP_SNAPSHOT_FIELD_MAX)
    expect(record.options[0]?.values).toHaveLength(ACP_SNAPSHOT_VALUES_LIMIT)
    expect(record.currentModeId).toBeNull()
  })

  it('总字节超限：先丢尾部非 model 类选项（model 保底），再剥 values；产物恒 ≤ 16384 字节', () => {
    const fat = (id: string) =>
      ({
        type: 'select',
        id,
        name: id,
        currentValue: 'v',
        options: Array.from({ length: ACP_SNAPSHOT_VALUES_LIMIT }, (_, index) => ({ value: `${id}-${'y'.repeat(100)}${String(index)}`, name: 'v' })),
      }) as never
    const record = acpOptionsSnapshotOf([fat('model'), fat('a'), fat('b'), fat('c')], undefined, 'fp-3', TIME_BASE)
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(ACP_SNAPSHOT_TOTAL_BYTES)
    // model 类保底保留
    expect(record.options.some((option) => option.id === 'model')).toBe(true)
    expect(record.options.length).toBeLessThan(4)
  })

  it('写路径语义门槛：畸形快照 / 绕过 acpOptionsSnapshotOf 的超界快照 → TypeError，不落行', async () => {
    // 写路径校验是同步 throw（方法非 async）
    expect(() =>
      store.writeOptionSnapshot(SessionId('sess-1'), { options: [{ id: '', category: null, name: 'x', value: 'v', values: null }], currentModeId: null, updatedAt: 1, fingerprint: 'fp' } as AcpOptionsSnapshotRecord),
    ).toThrow(TypeError)
    // 字段/条数均在语义上限内、但整体超字节界：32 选项 × 64 值 × 128 字符 ≈ 270KB
    const oversized: AcpOptionsSnapshotRecord = {
      options: Array.from({ length: ACP_SNAPSHOT_OPTION_LIMIT }, (_, index) => ({
        id: `opt-${String(index)}`,
        category: null,
        name: 'n',
        value: 'v',
        values: Array.from({ length: ACP_SNAPSHOT_VALUES_LIMIT }, () => 'z'.repeat(ACP_SNAPSHOT_FIELD_MAX)),
      })),
      currentModeId: null,
      updatedAt: 1,
      fingerprint: 'fp',
    }
    expect(() => store.writeOptionSnapshot(SessionId('sess-1'), oversized)).toThrow(TypeError)
    expect(await store.readOptionSnapshot(SessionId('sess-1'))).toBeUndefined()
  })

  it('畸形行 → undefined + warn（按「无快照」处理，不 throw）', async () => {
    await store.writeOptionSnapshot(
      SessionId('sess-1'),
      acpOptionsSnapshotOf([{ type: 'boolean', id: 'fast', name: 'Fast', currentValue: false } as never], undefined, 'fp-4', TIME_BASE),
    )
    const db = rawDb()
    try {
      db.prepare('UPDATE option_snapshots SET payload = ? WHERE dsh_session_id = ?').run('{"options":"not-an-array"', 'sess-1')
    } finally {
      db.close()
    }
    expect(await store.readOptionSnapshot(SessionId('sess-1'))).toBeUndefined()
    expect(warns.some((message) => message.includes('malformed'))).toBe(true)
  })

  it('upsert 覆盖同会话旧快照', async () => {
    await store.writeOptionSnapshot(SessionId('sess-1'), acpOptionsSnapshotOf([], 'code', 'fp-5', TIME_BASE))
    await store.writeOptionSnapshot(SessionId('sess-1'), acpOptionsSnapshotOf([], 'plan', 'fp-6', TIME_BASE + 1))
    expect((await store.readOptionSnapshot(SessionId('sess-1')))?.fingerprint).toBe('fp-6')
  })

  it('新快照可保存 Agent modes/context usage，旧快照仍按兼容形态读取', async () => {
    const record = acpOptionsSnapshotOf([], 'code', 'fp-new', TIME_BASE, {
      modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan', description: 'Planning' }] },
      contextUsage: { used: 42, size: 1000, cost: { amount: 0.3, currency: 'USD' } },
    })
    await store.writeOptionSnapshot(SessionId('sess-1'), record)
    expect(await store.readOptionSnapshot(SessionId('sess-1'))).toMatchObject({ modes: record.modes, contextUsage: record.contextUsage })
    await store.writeOptionSnapshot(SessionId('sess-2'), acpOptionsSnapshotOf([], undefined, 'fp-old', TIME_BASE))
    const old = await store.readOptionSnapshot(SessionId('sess-2'))
    expect(old?.modes).toBeUndefined()
    expect(old?.contextUsage).toBeUndefined()

    const zeroCapacity = acpOptionsSnapshotOf([], undefined, 'fp-zero', TIME_BASE, {
      contextUsage: { used: 0, size: 0, cost: null },
    })
    await store.writeOptionSnapshot(SessionId('sess-zero'), zeroCapacity)
    expect(await store.readOptionSnapshot(SessionId('sess-zero'))).toMatchObject({
      contextUsage: { used: 0, size: 0, cost: null },
    })
  })
})
