// sidecar.spec.ts — SQLite WAL 重写后的随附测试（src/persistence/sidecar.ts）。
//
// 旧 JSONL 用例 → 新实现语义映射（门槛不降）：
// - v2 envelope 磁盘格式逐字段钉版 → exportAudit('jsonl') 逐行重建 v2 envelope
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
// - compact 坏行隔离 → compact 重定义为 retention + VACUUM；
// - 原子写无 .tmp 残留 → 目录只出现 sidecar.sqlite 及其 -wal/-shm；
// - 并发 append 串行化 seq 独占、文件名安全边界（TypeError）、installAcpSidecar slot
//   选址——语义原样保留。
//
// 新增覆盖：权限位（目录 0700 / 库与 wal/shm 0600）、decided dedupe_key 幂等、
// 有界审计队列（满丢弃 + warn + flush 落齐；binding/permission 同步 durable 不走
// 队列）、exportAudit（jsonl/json、按 session/全量）、enforceRetention、health
// （quick_check/行计数/队列水位）、十万条 append 性能（线性耗时、无全文重写）、
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
  ACP_SIDECAR_CONFIG_AUDIT_ID,
  ACP_SIDECAR_DB_FILENAME,
  ACP_SIDECAR_DEFAULT_RETENTION_MS,
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
  type AcpPendingModelSwitch,
  type AcpSidecar,
  type AcpSidecarEnvelopeV2,
} from '../../../src/persistence/sidecar.ts'
import { createAgentConfigAudit, createPermissionAskedAudit, createPermissionDecidedAudit, type AcpPermissionAuditData } from '../../../src/domain/policy/events.ts'

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
    historyBaseSeq: 0,
    establishedAt: TIME_BASE,
    dshCommittedSeq: 8,
    ...overrides,
  }
}

const BINDING_A: AcpBindingData = bindingData()

const BINDING_B: AcpBindingData = bindingData({ agentSessionId: 'agent-session-2' })

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

/** 导出面逐条 parse 为 v2 envelope（落库产物的断言入口；导出行 = envelope 钉版形态）。 */
async function readEnvelopes(sessionId: string): Promise<AcpSidecarEnvelopeV2[]> {
  const text = await store.exportAudit({ sessionId: SessionId(sessionId), format: 'jsonl' })
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AcpSidecarEnvelopeV2)
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
  fs.rmSync(root, { recursive: true, force: true })
})

describe('createAcpSidecar 基本读写（v2 envelope 契约）', () => {
  it('append 落库：exportAudit 逐行重建 v2 envelope（schemaVersion/recordId/seq/time/kind/dshSessionId/acp*/payload 逐字段）', async () => {
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
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 40, data: BINDING_A })
    expect((await latestBinding('sess-1'))?.agentSessionId).toBe('agent-session-1')
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

  it('remove 幂等：存在即删（audit + bindings 行）、不存在不报错、不影响其他会话', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_A })
    await store.append(SessionId('sess-2'), { kind: 'binding', data: BINDING_B })
    await store.remove(SessionId('sess-1'))
    expect(await store.list(SessionId('sess-1'))).toEqual([])
    expect(await store.readLatestBinding(SessionId('sess-1'))).toBeUndefined()
    await store.remove(SessionId('sess-1'))
    expect((await latestBinding('sess-2'))?.agentSessionId).toBe('agent-session-2')
    // remove 后 seq 重新从 1 起（该 session 行集已整体清空）
    await store.append(SessionId('sess-1'), { kind: 'binding', data: BINDING_A })
    expect((await readEnvelopes('sess-1')).map((line) => line.seq)).toEqual([1])
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
  it('最新 binding 语义畸形 → {status:"outdated"}，绝不回退更早的合法 binding', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
 // 旧版（前）形状的 binding：envelope 合法但 payload 只有 provider/agentSessionId
    //（写路径不做语义校验——与 JSONL 时代一致；索引表 upsert 覆盖合法 binding）
    await store.append(SessionId('sess-1'), {
      kind: 'binding',
      time: 20,
      data: { provider: 'acp-devin', agentSessionId: 'agent-session-9' } as unknown as AcpBindingData,
    })
    expect(await store.readLatestBinding(SessionId('sess-1'))).toEqual({ status: 'outdated' })
    expect(warns.some((message) => message.includes('outdated'))).toBe(true)
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

describe(' 分轴审计 kind（permission-scope / agent-mode）', () => {
  it('两类新 kind 照常 append/list：envelope 字段齐、按序读回、acp 身份字段不编造', async () => {
    await store.append(SessionId('sess-1'), {
      kind: 'permission-scope',
      time: 1,
      data: { mode: 'workspace-write', confined: { workspaceRoot: '/proj', enforcement: 'full' }, platform: process.platform },
    })
    await store.append(SessionId('sess-1'), {
      kind: 'agent-mode',
      time: 2,
      data: { modeId: 'accept-edits', via: 'session-setup' },
    })
    await store.append(SessionId('sess-1'), {
      kind: 'permission-scope',
      time: 3,
      data: { mode: 'danger-full-access', confined: null, platform: process.platform },
    })

    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['permission-scope', 'agent-mode', 'permission-scope'])
    expect(entries[0]?.data).toEqual({
      mode: 'workspace-write',
      confined: { workspaceRoot: '/proj', enforcement: 'full' },
      platform: process.platform,
    })
    expect(entries[1]?.data).toEqual({ modeId: 'accept-edits', via: 'session-setup' })
    expect(entries[2]?.data).toEqual({ mode: 'danger-full-access', confined: null, platform: process.platform })
    // envelope 齐：seq 单调、recordId 派生（h: 前缀）、dshSessionId = 行键
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3])
    for (const entry of entries) {
      expect(entry.recordId).toMatch(/^h:/)
      expect(entry.dshSessionId).toBe('sess-1')
      // 新 kind 的 payload 无 acp 身份可推导（可推导才落，不编造）
      expect(entry.acpProviderId).toBeUndefined()
      expect(entry.acpSessionId).toBeUndefined()
    }
  })

  it('新 kind 不参与 decided 去重；同 payload 连写撞名追加序号', async () => {
    await store.append(SessionId('sess-1'), { kind: 'agent-mode', time: 1, data: { modeId: 'plan', via: 'set_mode' } })
    await store.append(SessionId('sess-1'), { kind: 'agent-mode', time: 1, data: { modeId: 'plan', via: 'set_mode' } })
    const entries = await store.list(SessionId('sess-1'))
    expect(entries).toHaveLength(2)
    expect(entries[1]?.recordId).toBe(`${entries[0]?.recordId ?? ''}-2`)
  })
})

describe(' 配置审计 kind（agent-config 专档）', () => {
  it('专档行键可写可读：append/list 往返，env 键名 diff 原样读回，envelope 字段齐', async () => {
    const audit = createAgentConfigAudit({
      change: 'changed',
      agentId: 'devin',
      changedFields: ['env', 'command'],
      command: 'devin-next',
      env: { added: ['NEW_FLAG'], removed: [], changed: ['DEVIN_API_KEY'] },
    })
    await store.append(SessionId(ACP_SIDECAR_CONFIG_AUDIT_ID), { kind: 'agent-config', time: 1, data: audit })
    const entries = await store.list(SessionId(ACP_SIDECAR_CONFIG_AUDIT_ID))
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.kind).toBe('agent-config')
    // changedFields 由工厂排序固定（recordId 哈希稳定）；env 只携带键名级 diff
    expect(entry?.data).toEqual({
      change: 'changed',
      agentId: 'devin',
      changedFields: ['command', 'env'],
      command: 'devin-next',
      env: { added: ['NEW_FLAG'], removed: [], changed: ['DEVIN_API_KEY'] },
    })
    expect(entry?.dshSessionId).toBe('agent-config')
    expect(entry?.recordId).toMatch(/^h:/)
    expect(entry?.seq).toBe(1)
    // 专档不落任何会话 binding：全量 binding 索引对它无感
    expect(await store.listBindings()).toEqual([])
  })

  it('密钥纪律钉版：审计 payload 序列化后不含 env 值（只记「已变更」事实）', async () => {
    const audit = createAgentConfigAudit({
      change: 'changed',
      agentId: 'devin',
      changedFields: ['env'],
      env: { added: [], removed: [], changed: ['DEVIN_API_KEY'] },
    })
    await store.append(SessionId(ACP_SIDECAR_CONFIG_AUDIT_ID), { kind: 'agent-config', data: audit })
    const raw = await store.exportAudit({ sessionId: SessionId(ACP_SIDECAR_CONFIG_AUDIT_ID), format: 'jsonl' })
    expect(raw).toContain('DEVIN_API_KEY')
    expect(raw).not.toContain('sk-')
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

  it('库不存在时 compact/enforceRetention/exportAudit/health 均不建库', async () => {
    await store.compact(SessionId('ghost'))
    expect(await store.enforceRetention()).toMatchObject({ removed: 0 })
    expect(await store.exportAudit()).toBe('')
    const health = await store.health()
    expect(health.exists).toBe(false)
    expect(health.integrity).toBe('absent')
    expect(fs.readdirSync(root)).toEqual([])
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
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 10, data: BINDING_A })
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

describe('compact = retention + VACUUM（重定义）', () => {
  it('超龄 audit 行删除、新鲜行保留；bindings 索引不受 retention 影响；VACUUM 后库正常', async () => {
    const now = TIME_BASE + 100_000
    const retained = createAcpSidecar({ root, now: () => now, warn: (message) => warns.push(message), retentionMs: 1_000 })
    await retained.append(SessionId('sess-1'), { kind: 'binding', time: now - 10_000, data: BINDING_A })
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now - 9_000, data: permissionData('req-old') })
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now - 500, data: permissionData('req-fresh') })

    await retained.compact(SessionId('sess-1'))
    const entries = await retained.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['permission'])
    expect(entries[0]?.data).toEqual(permissionData('req-fresh'))
    // bindings 索引是恢复证据，不被 retention 清除
    const lookup = await retained.readLatestBinding(SessionId('sess-1'))
    expect(lookup?.status).toBe('ok')
    expect((await retained.health()).integrity).toBe('ok')
    // compact 后照写
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now, data: permissionData('req-post') })
    expect((await retained.list(SessionId('sess-1')))).toHaveLength(2)
  })

  it('VACUUM 压实：大量超龄行删除后主库文件缩小', async () => {
    const now = TIME_BASE + 1_000_000
    const retained = createAcpSidecar({ root, now: () => now, warn: (message) => warns.push(message), retentionMs: 1_000 })
    const bigPayload = {
      cause: 'replay-diverged' as const,
      detail: 'x'.repeat(512),
      acpSessionId: 'agent-session-1',
    }
    for (let index = 0; index < 2_000; index += 1) {
      await retained.append(SessionId('sess-1'), { kind: 'reconciliation', time: now - 10_000, data: { ...bigPayload, detail: `${String(index)}-${'x'.repeat(512)}` } })
    }
    await retained.flush()
    const before = fs.statSync(dbFile()).size
    await retained.compact(SessionId('sess-1'))
    const after = fs.statSync(dbFile()).size
    expect(after).toBeLessThan(before)
    expect(await retained.list(SessionId('sess-1'))).toEqual([])
  })

  it('compact 的 retentionMs 参数覆盖构造默认（调用方给定策略）', async () => {
    const now = TIME_BASE + 100_000
    const retained = createAcpSidecar({ root, now: () => now, warn: (message) => warns.push(message), retentionMs: 60_000 })
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now - 10_000, data: permissionData('req-1') })
    // 构造默认 60s 保留期内 → 不动；调用方给 1s → 删
    await retained.compact(SessionId('sess-1'))
    expect(await retained.list(SessionId('sess-1'))).toHaveLength(1)
    await retained.compact(SessionId('sess-1'), 1_000)
    expect(await retained.list(SessionId('sess-1'))).toEqual([])
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
    expect((await store.health()).queuedEntries).toBe(0)
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

  it('队列满 → 丢弃新记录并 warn 计数（绝不阻塞）；health 暴露丢弃数', async () => {
    const limited = createAcpSidecar({ root, now: () => ++clock, warn: (message) => warns.push(message), queueLimit: 4 })
    for (let index = 0; index < 6; index += 1) {
      void limited.append(SessionId('sess-1'), { kind: 'degradation', time: index, data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false } })
    }
    await limited.flush()
    expect(await limited.list(SessionId('sess-1'))).toHaveLength(4)
    const health = await limited.health()
    expect(health.droppedEntries).toBe(2)
    expect(warns.some((message) => message.includes('audit queue is full (limit 4)'))).toBe(true)
  })

  it('默认队列上限常量导出（1024）', () => {
    expect(ACP_SIDECAR_AUDIT_QUEUE_LIMIT).toBe(1024)
  })

  it('队列批量落库保持追加序：混合排队 kind 的 seq 单调、读回顺序与 append 序一致', async () => {
    for (let index = 0; index < 50; index += 1) {
      await store.append(SessionId('sess-1'), { kind: 'agent-mode', time: index, data: { modeId: `mode-${String(index)}`, via: 'set_mode' } })
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
    expect((await store.health()).droppedEntries).toBe(1)
    // 触发器拆除后：照写照读（丢弃的非审批审计不毒化后续）
    await store.append(SessionId('sess-1'), { kind: 'degradation', time: 3, data: { code: 'unsupported-chunk-content', items: [], keptPreviewChars: 0, truncated: false } })
    const entries = await store.list(SessionId('sess-1'))
    expect(entries.map((entry) => entry.kind)).toEqual(['binding', 'degradation'])
  })
})

describe('权限位（目录 0700 / 库与 wal/shm 0600）', () => {
  it('append 后 root 0700、sidecar.sqlite 0600、wal/shm 0600', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
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

describe('exportAudit（插件级导出 API）', () => {
  it('jsonl 默认格式：每行一条 v2 envelope，结尾换行；按 session 限定', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.append(SessionId('sess-2'), { kind: 'binding', time: 2, data: BINDING_B })
    const text = await store.exportAudit({ sessionId: SessionId('sess-1') })
    const lines = text.split('\n')
    expect(lines).toHaveLength(2) // 一条记录 + 结尾空串
    expect(lines[1]).toBe('')
    const envelope = JSON.parse(lines[0] ?? '') as AcpSidecarEnvelopeV2
    expect(envelope.dshSessionId).toBe('sess-1')
    expect(envelope.schemaVersion).toBe(ACP_SIDECAR_SCHEMA_VERSION)
  })

  it('json 格式：envelope 数组；全量导出含多 session 与 agent-config 专档', async () => {
    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.append(SessionId('sess-2'), { kind: 'permission', time: 2, data: permissionData('req-1') })
    await store.append(SessionId(ACP_SIDECAR_CONFIG_AUDIT_ID), {
      kind: 'agent-config',
      time: 3,
      data: createAgentConfigAudit({ change: 'added', agentId: 'devin', changedFields: [] }),
    })
    const parsed = JSON.parse(await store.exportAudit({ format: 'json' })) as AcpSidecarEnvelopeV2[]
    expect(parsed.map((line) => line.dshSessionId).sort()).toEqual(['agent-config', 'sess-1', 'sess-2'])
    expect(parsed.map((line) => line.kind).sort()).toEqual(['agent-config', 'binding', 'permission'])
  })

  it('库不存在 → 空导出（jsonl 空串 / json 空数组），不建库', async () => {
    expect(await store.exportAudit()).toBe('')
    expect(JSON.parse(await store.exportAudit({ format: 'json' }))).toEqual([])
    expect(fs.existsSync(dbFile())).toBe(false)
  })
})

describe('enforceRetention（插件级 retention API）', () => {
  it('删除超龄 audit 行并返回计数与 cutoff；bindings 不动；可按 session 限定', async () => {
    const now = TIME_BASE + 100_000
    const retained = createAcpSidecar({ root, now: () => now, warn: (message) => warns.push(message) })
    await retained.append(SessionId('sess-1'), { kind: 'binding', time: now - 40 * 24 * 3600 * 1000, data: BINDING_A })
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now - 40 * 24 * 3600 * 1000, data: permissionData('req-old') })
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now, data: permissionData('req-new') })
    await retained.append(SessionId('sess-2'), { kind: 'permission', time: now - 40 * 24 * 3600 * 1000, data: permissionData('req-other') })

    // 默认保留期（30 天）的全库清理：sess-1 的超龄 binding/permission 两行 +
    // sess-2 的超龄行一行，共 3 行删除（binding 的 audit 历史行受 retention，
    // bindings 最新索引不动）
    const full = await retained.enforceRetention()
    expect(full.removed).toBe(3)
    expect(full.cutoff).toBe(now - ACP_SIDECAR_DEFAULT_RETENTION_MS)
    expect((await retained.list(SessionId('sess-1'))).map((entry) => entry.kind)).toEqual(['permission'])
    expect((await retained.readLatestBinding(SessionId('sess-1')))?.status).toBe('ok')
    expect(await retained.list(SessionId('sess-2'))).toEqual([])

    // 按 session 限定 + 自定义阈值
    await retained.append(SessionId('sess-2'), { kind: 'permission', time: now - 40 * 24 * 3600 * 1000, data: permissionData('req-other-2') })
    await retained.append(SessionId('sess-1'), { kind: 'permission', time: now - 40 * 24 * 3600 * 1000, data: permissionData('req-scoped-skip') })
    const scoped = await retained.enforceRetention({ sessionId: SessionId('sess-2'), olderThanMs: 1_000 })
    expect(scoped.removed).toBe(1)
    expect(await retained.list(SessionId('sess-2'))).toEqual([])
    // 非目标 session 的超龄行不动
    expect((await retained.list(SessionId('sess-1'))).map((entry) => entry.kind)).toEqual(['permission', 'permission'])
  })
})

describe('health（健康行）', () => {
  it('库创建前后：absent → ok；行计数、WAL 大小、quick_check、队列水位', async () => {
    const before = await store.health()
    expect(before).toMatchObject({ exists: false, integrity: 'absent', auditRows: 0, bindingRows: 0, dbBytes: 0, walBytes: 0, droppedEntries: 0 })
    expect(before.dbPath).toBe(dbFile())

    await store.append(SessionId('sess-1'), { kind: 'binding', time: 1, data: BINDING_A })
    await store.append(SessionId('sess-1'), { kind: 'permission', time: 2, data: permissionData('req-1') })
    await store.append(SessionId('sess-2'), { kind: 'binding', time: 3, data: BINDING_B })
    const after = await store.health()
    expect(after.exists).toBe(true)
    expect(after.integrity).toBe('ok')
    expect(after.auditRows).toBe(3)
    expect(after.bindingRows).toBe(2)
    expect(after.dbBytes).toBeGreaterThan(0)
    expect(after.queuedEntries).toBe(0)
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

describe('性能：十万条 append（O(1) 追加，无全文件重写）', () => {
  it('100k 同步路径 append 在预算内完成且耗时按批线性（无二次方重写）', async () => {
    const N = 100_000
    const started = performance.now()
    const marks: number[] = []
    for (let index = 0; index < N; index += 1) {
      await store.append(SessionId('sess-bench'), { kind: 'permission', time: index + 1, data: permissionData(`req-${String(index)}`) })
      if ((index + 1) % 10_000 === 0) marks.push(performance.now() - started)
    }
    const elapsed = performance.now() - started
    // 预算：本地实测 ~5s（Node 24.19 / macOS arm64）；CI 给 6 倍余量
    expect(elapsed).toBeLessThan(30_000)
    // 线性证据：末批 10k 与首批 10k 耗时同量级（JSONL 全文重写是 O(n²)，末批会是首批的 ~10x+）
    const first = marks[0] ?? 0
    const last = (marks[9] ?? 0) - (marks[8] ?? 0)
    expect(first).toBeGreaterThan(0)
    expect(last).toBeLessThan(first * 5)
    const health = await store.health()
    expect(health.auditRows).toBe(N)
    expect(health.integrity).toBe('ok')
    // 存储量有界：单库 + WAL 总量与 payload 总量同量级（无重写垃圾）
    expect(health.dbBytes + health.walBytes).toBeLessThan(N * 1024)
    const entries = await store.list(SessionId('sess-bench'))
    expect(entries).toHaveLength(N)
    expect(entries[0]?.seq).toBe(1)
    expect(entries[N - 1]?.seq).toBe(N)
  }, 90_000)
})

describe('createAcpSidecar 行键安全边界', () => {
  it('非法 sessionId 一律同步抛 TypeError（append/list/remove/readLatestBinding/compact/export/enforceRetention）', () => {
    const illegal = ['../escape', '..', '.', 'a/b', 'a\\b', '', 'with space']
    for (const id of illegal) {
      expect(() => store.append(SessionId(id), { kind: 'binding', data: BINDING_A })).toThrow(TypeError)
      expect(() => store.list(SessionId(id))).toThrow(TypeError)
      expect(() => store.remove(SessionId(id))).toThrow(TypeError)
      expect(() => store.readLatestBinding(SessionId(id))).toThrow(TypeError)
      expect(() => store.compact(SessionId(id))).toThrow(TypeError)
      expect(() => store.exportAudit({ sessionId: SessionId(id) })).toThrow(TypeError)
      expect(() => store.enforceRetention({ sessionId: SessionId(id) })).toThrow(TypeError)
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
      const exported = await installed?.exportAudit({ sessionId: SessionId('sess-9'), format: 'jsonl' })
      const envelope = JSON.parse((exported ?? '').trim()) as AcpSidecarEnvelopeV2
      expect(envelope.schemaVersion).toBe(ACP_SIDECAR_SCHEMA_VERSION)
      const lookup = await installed?.readLatestBinding(SessionId('sess-9'))
      expect(lookup?.status).toBe('ok')
      expect(lookup?.status === 'ok' && lookup.binding.agentSessionId).toBe('agent-session-1')
      await installed?.dispose()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})


// ---------- 待定模型切换（model_switches 表） ----------

/** 全字段 pending switch 夹具（缺任一必填字段即 corrupt——门槛测试按字段删）。 */
function pendingSwitch(overrides: Partial<AcpPendingModelSwitch> = {}): AcpPendingModelSwitch {
  return {
    operationId: 'op-1',
    dshSessionId: 'sess-1',
    provider: 'acp-devin',
    optionId: 'model',
    previousModel: 'devin-fast',
    targetModel: 'devin-max',
    state: 'started',
    createdAt: new Date(TIME_BASE).toISOString(),
    ...overrides,
  }
}

describe(' 待定模型切换（model_switches 表）', () => {
  it('write → read 往返逐字段一致；同会话 upsert 覆盖（每会话至多一行）', async () => {
    expect(await store.readPendingModelSwitch(SessionId('sess-1'))).toBeUndefined()
    await store.writePendingModelSwitch(pendingSwitch())
    const first = await store.readPendingModelSwitch(SessionId('sess-1'))
    expect(first).toEqual({ status: 'ok', record: pendingSwitch() })

    await store.writePendingModelSwitch(pendingSwitch({ state: 'agent-applied' }))
    const second = await store.readPendingModelSwitch(SessionId('sess-1'))
    expect(second).toEqual({ status: 'ok', record: pendingSwitch({ state: 'agent-applied' }) })
    // 其他会话不受影响
    expect(await store.readPendingModelSwitch(SessionId('sess-2'))).toBeUndefined()
  })

  it('五态词表全收（含 agent-rolled-back）；未知 state → TypeError', async () => {
    for (const state of ['started', 'agent-applied', 'agent-rolled-back', 'committed', 'rollback-required'] as const) {
      await store.writePendingModelSwitch(pendingSwitch({ state }))
      const lookup = await store.readPendingModelSwitch(SessionId('sess-1'))
      expect(lookup?.status === 'ok' && lookup.record.state).toBe(state)
    }
    // 写路径校验是同步 throw（方法非 async，失败不占用 promise）
    expect(() => store.writePendingModelSwitch(pendingSwitch({ state: 'bogus' as never }))).toThrow(TypeError)
  })

  it('appliedModel 可选但在场必须为非空字符串', async () => {
    await store.writePendingModelSwitch(pendingSwitch({ state: 'agent-applied', appliedModel: 'devin-max-normalized' }))
    expect(await store.readPendingModelSwitch(SessionId('sess-1'))).toEqual({
      status: 'ok',
      record: pendingSwitch({ state: 'agent-applied', appliedModel: 'devin-max-normalized' }),
    })
    expect(() => store.writePendingModelSwitch(pendingSwitch({ appliedModel: '' }))).toThrow(TypeError)
  })

  it('缺必填字段/空串 → write 拒绝（TypeError），不落行', async () => {
    expect(() => store.writePendingModelSwitch(pendingSwitch({ operationId: '' }))).toThrow(TypeError)
    expect(() => store.writePendingModelSwitch(pendingSwitch({ previousModel: 42 as never }))).toThrow(TypeError)
    expect(await store.readPendingModelSwitch(SessionId('sess-1'))).toBeUndefined()
  })

  it('clear 幂等：存在即删、不存在不报错；remove 一并清行', async () => {
    await store.clearPendingModelSwitch(SessionId('ghost'))
    await store.writePendingModelSwitch(pendingSwitch())
    await store.clearPendingModelSwitch(SessionId('sess-1'))
    expect(await store.readPendingModelSwitch(SessionId('sess-1'))).toBeUndefined()
    await store.clearPendingModelSwitch(SessionId('sess-1'))

    await store.writePendingModelSwitch(pendingSwitch())
    await store.remove(SessionId('sess-1'))
    expect(await store.readPendingModelSwitch(SessionId('sess-1'))).toBeUndefined()
  })

  it('畸形行 → {status:"corrupt"} + warn（绝不静默忽略、不回退无行）', async () => {
    // 先写一行合法行让库存在，再经第二个连接篡改 payload
    await store.writePendingModelSwitch(pendingSwitch())
    const db = rawDb()
    try {
      db.prepare('UPDATE model_switches SET payload = ? WHERE dsh_session_id = ?').run('{"state":"half-written"', 'sess-1')
    } finally {
      db.close()
    }
    const lookup = await store.readPendingModelSwitch(SessionId('sess-1'))
    expect(lookup).toEqual({ status: 'corrupt' })
    expect(warns.some((message) => message.includes('malformed'))).toBe(true)

    // payload 合法但 dshSessionId 与行键不一致 → 同样 corrupt
    const db2 = rawDb()
    try {
      db2.prepare('UPDATE model_switches SET payload = ? WHERE dsh_session_id = ?').run(JSON.stringify(pendingSwitch({ dshSessionId: 'sess-other' })), 'sess-1')
    } finally {
      db2.close()
    }
    expect(await store.readPendingModelSwitch(SessionId('sess-1'))).toEqual({ status: 'corrupt' })
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

  it('remove 一并清快照行；upsert 覆盖同会话旧快照', async () => {
    await store.writeOptionSnapshot(SessionId('sess-1'), acpOptionsSnapshotOf([], 'code', 'fp-5', TIME_BASE))
    await store.writeOptionSnapshot(SessionId('sess-1'), acpOptionsSnapshotOf([], 'plan', 'fp-6', TIME_BASE + 1))
    expect((await store.readOptionSnapshot(SessionId('sess-1')))?.fingerprint).toBe('fp-6')
    await store.remove(SessionId('sess-1'))
    expect(await store.readOptionSnapshot(SessionId('sess-1'))).toBeUndefined()
  })
})
