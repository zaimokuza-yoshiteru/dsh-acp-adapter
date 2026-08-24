// permissions.spec.ts — 随附测试（/sidecar 持久化规则 迁移； fail-closed 收尾；
// 审批语义精确匹配）：审批桥（src/domain/policy/permissions.ts）+ 审计载荷
// （src/domain/policy/events.ts）。审计通道已从 sessionPersistence marker 迁移到
// sidecar entry（`{kind:'permission', time, data}`）——不再断言 seq/ignorable
// envelope（sidecar 无 session-log seq 概念，亦无 ignorable 语义）。
//
// 单测（假 approval 服务 + 假审计通道）：
//   - 各结局映射：allow_once / reject_once / dsh cancelled / unavailable；
// option 矩阵：once-kind 缺席（仅 always / 完全缺失 / 仅未知 kind）一律
//     cancelled + note allow-once-unsupported / reject-once-unsupported——任何
//     用例都不得返回 always 类 optionId（一次性选择绝不升格永久授权/拒绝）
//   - fail closed：turn 外到达、approval 服务缺席、approval 抛错、asked/decided
//     审计落盘失败（即便审批通过也 cancelled）
//   - 审计断言：record 形状 {kind, time, data}、asked 含完整 options 与 toolCall
//     快照（rawInput 落脱敏摘要 rawInputSummary + 哈希 rawInputHash，
//     不落原文）、decided 含 outcome/optionId/approvalOutcome/
// note（拒绝结案带 user-rejected 分类词；无 degraded 字段）、
//     asked→approval→decided 顺序、同 turn 多次请求的记录顺序与 requestId 配对
// - 断连语义：审批挂起且 turn 存活时桥忠实等待不伪造答复，abort 到达才
// 结算 cancelled； always-only agent 每次请求都得 cancelled（不授权），
//     不存在「已永久授权」状态可言
//   - reason 组装：title/kind/rawInput 摘要/locations/once-kind 可用性披露/截断
//
// e2e（真 AcpClientConnection + mock-agent permission-flow + 内联 always-only agent）：
//   allow_once / rejected / abort→cancelled / always-only → cancelled / dispose 次序
//   （abort→结算→close），断言 mock 侧 MOCK_LOG 记录的 optionId 与 turn 结局
//   （handler 接线处直接 new AcpClientConnection；生产接线位于 agent.ts，
//   不在本文件范围）。
//
// 孤儿进程防线同 acp-client.spec.ts：spawn argv 携带 SPEC_TAG（含本 worker pid），
// afterEach 兜底 close，afterAll 逐 pid 断言已死 + ps 全量扫描 SPEC_TAG。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import {
  ACP_PERMISSION_AUDIT_KIND,
  createPermissionAskedAudit,
  createPermissionDecidedAudit,
  isPermissionAskedAudit,
  isPermissionDecidedAudit,
  type AcpPermissionAskedAuditData,
  type AcpPermissionDecidedAuditData,
} from '../../../src/domain/policy/events.ts'
import {
  ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE,
  ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE,
  buildPermissionReason,
  createAcpPermissionHandler,
  type AcpApprovalOutcome,
  type AcpApprovalRequest,
  type AcpApprovalRequester,
  type AcpPermissionAuditChannel,
  type AcpPermissionAuditRecord,
  type AcpPermissionBridgeDeps,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpLogFields } from '../../../src/domain/observability/logging.ts'
import { AcpMetricsRegistry, type AcpMetricsLike } from '../../../src/domain/observability/metrics.ts'

// ---------- fixtures ----------

const TIME_BASE = 1_700_000_000_000

/** mock-agent permission-flow 同款四选项（固定形状，供「完整 options 原样」断言）。 */
const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
]

const PARAMS: acp.RequestPermissionRequest = {
  sessionId: 'mock-session-1',
  toolCall: {
    toolCallId: 'mock-tool-perm-1',
    title: 'Run: echo hello',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'echo hello' },
    locations: [{ path: '/work/a.txt' }],
  },
  options: PERMISSION_OPTIONS,
}

/** 审批桥只把 agent 透传给 approval.request；假对象足以断言透传（toBe）。 */
const FAKE_AGENT = { marker: 'fake-agent' } as unknown as Agent

// ---------- fakes ----------

class FakeAuditChannel implements AcpPermissionAuditChannel {
  readonly records: AcpPermissionAuditRecord[] = []
  /** 第 N 次（0 基）append 调用注入失败。 */
  failOnAppend: number | undefined

  constructor(private readonly order?: string[]) {}

  append(record: AcpPermissionAuditRecord): Promise<void> {
    if (this.failOnAppend !== undefined && this.records.length === this.failOnAppend) {
      this.failOnAppend = undefined
      return Promise.reject(new Error('injected append failure'))
    }
    // JSON 往返：断言所录即持久层 lossless snapshot 后的形状
    const persisted = JSON.parse(JSON.stringify(record)) as AcpPermissionAuditRecord
    this.records.push(persisted)
    this.order?.push(`audit:${persisted.data.phase}`)
    return Promise.resolve()
  }
}

class FakeApproval implements AcpApprovalRequester {
  readonly requests: AcpApprovalRequest[] = []
  outcome: AcpApprovalOutcome = 'allowed-once'
  /** 自定义应答（如等待 abort）；缺省直接回 outcome。 */
  handler: ((req: AcpApprovalRequest) => AcpApprovalOutcome | Promise<AcpApprovalOutcome>) | undefined

  constructor(private readonly order?: string[]) {}

  async request(req: AcpApprovalRequest): Promise<AcpApprovalOutcome> {
    this.requests.push(req)
    this.order?.push('approval')
    if (this.handler !== undefined) return await this.handler(req)
    return this.outcome
  }
}

interface DepsOverrides {
  /** false = approval 服务缺席（UI 不可用）。 */
  includeApproval?: boolean
  hasOpenTurn?: boolean
  turnSignal?: AbortSignal
 /** 指标 sink（审批 requested/decided 配对计数）。 */
  metrics?: AcpMetricsLike
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: AcpPermissionBridgeDeps
  audit: FakeAuditChannel
  approval: FakeApproval
  logs: string[]
  logFields: (AcpLogFields | undefined)[]
  order: string[]
} {
  const order: string[] = []
  const logs: string[] = []
  const logFields: (AcpLogFields | undefined)[] = []
  const audit = new FakeAuditChannel(order)
  const approval = new FakeApproval(order)
  let time = TIME_BASE
  const signal = overrides.turnSignal
  const deps: AcpPermissionBridgeDeps = {
    agent: FAKE_AGENT,
    audit,
    hasOpenTurn: () => overrides.hasOpenTurn ?? true,
    log: (message, fields) => {
      logs.push(message)
      logFields.push(fields)
    },
    now: () => {
      time += 1
      return time
    },
    ...(overrides.includeApproval === false ? {} : { approval }),
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
    ...(signal === undefined ? {} : { turnSignal: () => signal }),
  }
  return { deps, audit, approval, logs, logFields, order }
}

function askedDataOf(record: AcpPermissionAuditRecord | undefined): AcpPermissionAskedAuditData {
  if (record === undefined || !isPermissionAskedAudit(record.data)) {
    throw new Error('expected an asked audit record')
  }
  return record.data
}

function decidedDataOf(record: AcpPermissionAuditRecord | undefined): AcpPermissionDecidedAuditData {
  if (record === undefined || !isPermissionDecidedAudit(record.data)) {
    throw new Error('expected a decided audit record')
  }
  return record.data
}

// ---------- events.ts：审计载荷构造器与类型守卫 ----------

describe('events.ts 审计载荷构造器与类型守卫', () => {
  it('asked 构造器：toolCall 快照与完整 options 原样', () => {
    const data = createPermissionAskedAudit({
      requestId: 'req-1',
      agentSessionId: 'mock-session-1',
      toolCall: PARAMS.toolCall,
      options: PARAMS.options,
    })
    expect(data.phase).toBe('asked')
    expect(data.requestId).toBe('req-1')
    expect(data.agentSessionId).toBe('mock-session-1')
    expect(data.toolCall).toEqual({
      toolCallId: 'mock-tool-perm-1',
      title: 'Run: echo hello',
      kind: 'execute',
      locations: [{ path: '/work/a.txt' }],
      // rawInput 不再原文落盘，改落脱敏摘要 + canonical 哈希
      rawInputSummary: '{"command":"echo hello"}',
      rawInputHash: data.toolCall.rawInputHash,
    })
    expect(data.toolCall.rawInputHash).toMatch(/^[0-9a-f]{16}$/)
    // 完整 options 原样（含 always 类，含 name 文案）
    expect(data.options).toEqual(PERMISSION_OPTIONS)
    expect(isPermissionAskedAudit(data)).toBe(true)
    expect(isPermissionDecidedAudit(data)).toBe(false)
  })

  it('asked 构造器对缺省 title/kind/locations/rawInput 的 toolCall 只落 toolCallId', () => {
    const data = createPermissionAskedAudit({
      requestId: 'req-2',
      agentSessionId: 's',
      toolCall: { toolCallId: 'tc-bare' },
      options: [],
    })
    expect(data.toolCall).toEqual({ toolCallId: 'tc-bare' })
    expect('title' in data.toolCall).toBe(false)
    expect('kind' in data.toolCall).toBe(false)
    expect('locations' in data.toolCall).toBe(false)
    expect('rawInputSummary' in data.toolCall).toBe(false)
    expect('rawInputHash' in data.toolCall).toBe(false)
  })

  it('asked 构造器：rawInput 的 secret 键值脱敏、哈希取自原文 canonical', () => {
    const data = createPermissionAskedAudit({
      requestId: 'req-redact',
      agentSessionId: 's',
      toolCall: {
        toolCallId: 'tc-secret',
        rawInput: { command: 'deploy', token: 'abc123', nested: { apiKey: 'k-9', note: 'ok' } },
      },
      options: [],
    })
    expect(data.toolCall.rawInputSummary).toBe(
      '{"command":"deploy","nested":{"apiKey":"<redacted>","note":"ok"},"token":"<redacted>"}',
    )
    expect(data.toolCall.rawInputSummary).not.toContain('abc123')
    expect(data.toolCall.rawInputSummary).not.toContain('k-9')
    expect(data.toolCall.rawInputHash).toMatch(/^[0-9a-f]{16}$/)
    // 哈希与生产者键序无关（canonical 输入）
    const reordered = createPermissionAskedAudit({
      requestId: 'req-redact-2',
      agentSessionId: 's',
      toolCall: {
        toolCallId: 'tc-secret',
        rawInput: { nested: { note: 'ok', apiKey: 'k-9' }, token: 'abc123', command: 'deploy' },
      },
      options: [],
    })
    expect(reordered.toolCall.rawInputHash).toBe(data.toolCall.rawInputHash)
  })

 it('decided 构造器：可选字段缺席而非 undefined（起无 degraded 字段；agentSessionId/toolCallId 必填）', () => {
    const cancelled = createPermissionDecidedAudit({
      requestId: 'req-1',
      agentSessionId: 'mock-session-1',
      toolCallId: 'mock-tool-perm-1',
      outcome: 'cancelled',
      approvalOutcome: 'cancelled',
      note: 'cancelled',
    })
    expect(cancelled).toEqual({
      phase: 'decided',
      requestId: 'req-1',
      agentSessionId: 'mock-session-1',
      toolCallId: 'mock-tool-perm-1',
      outcome: 'cancelled',
      approvalOutcome: 'cancelled',
      note: 'cancelled',
    })
    expect('optionId' in cancelled).toBe(false)
 // 历史钉：degraded 机制已删除，构造器永不产出该字段
    expect('degraded' in cancelled).toBe(false)

    const selected = createPermissionDecidedAudit({
      requestId: 'req-1',
      agentSessionId: 'mock-session-1',
      toolCallId: 'mock-tool-perm-1',
      outcome: 'selected',
      optionId: 'allow_once',
      approvalOutcome: 'allowed-once',
    })
    expect(selected).toEqual({
      phase: 'decided',
      requestId: 'req-1',
      agentSessionId: 'mock-session-1',
      toolCallId: 'mock-tool-perm-1',
      outcome: 'selected',
      optionId: 'allow_once',
      approvalOutcome: 'allowed-once',
    })
    expect('degraded' in selected).toBe(false)
    expect(isPermissionAskedAudit(selected)).toBe(false)
    expect(isPermissionDecidedAudit(selected)).toBe(true)
  })
})

// ---------- 审批桥单测 ----------

describe('createAcpPermissionHandler 结局映射', () => {
  it('allowed-once → allow_once 选项 id；asked→approval→decided 顺序与 record 全要素', async () => {
    const { deps, audit, approval, order } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(order).toEqual(['audit:asked', 'approval', 'audit:decided'])

    expect(approval.requests).toHaveLength(1)
    const req = approval.requests[0]
    expect(req?.agent).toBe(FAKE_AGENT)
    expect(req?.toolName).toBe('Run: echo hello')
    expect(req?.callId).toBe('mock-tool-perm-1')
    expect(req?.signal).toBeUndefined()
    expect(req?.reason).toContain('工具：Run: echo hello')
    expect(req?.reason).toContain('命令：echo hello')
    expect(req?.reason).not.toContain('/work/a.txt')
    expect(req?.reason).not.toContain(ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE)
    expect(req?.reason).not.toContain(ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE)

    expect(audit.records).toHaveLength(2)
    const asked = audit.records[0]
    expect(asked?.kind).toBe(ACP_PERMISSION_AUDIT_KIND)
    expect(asked?.time).toBe(TIME_BASE + 1)
    const askedData = askedDataOf(asked)
    expect(askedData.agentSessionId).toBe('mock-session-1')
    expect(askedData.options).toEqual(PERMISSION_OPTIONS)
    // requestId 为 randomUUID 形态（跨进程/跨重启唯一，不再是模块级计数器）
    expect(askedData.requestId).toMatch(/^dsh-acp-permission-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const decided = audit.records[1]
    expect(decided?.kind).toBe(ACP_PERMISSION_AUDIT_KIND)
    expect(decided?.time).toBe(TIME_BASE + 2)
    const decidedData = decidedDataOf(decided)
    expect(decidedData.requestId).toBe(askedData.requestId)
    expect(decidedData).toMatchObject({
      agentSessionId: 'mock-session-1',
      toolCallId: 'mock-tool-perm-1',
      outcome: 'selected',
      optionId: 'allow_once',
      approvalOutcome: 'allowed-once',
    })
    expect('degraded' in decidedData).toBe(false)
  })

  it('name/title 双缺（真机 Devin 形态）：toolName 回退为含 callId 的有界标签，fail-closed 语义不变', async () => {
    const { deps, audit, approval } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    const response = await handler({
      ...PARAMS,
      toolCall: { toolCallId: 'mock-tool-perm-1', status: 'pending' },
    })

    // 正常结局映射不受影响（still selected，不是 cancelled）
    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(approval.requests).toHaveLength(1)
    expect(approval.requests[0]?.toolName).toBe('Agent 工具请求 (mock-tool-perm-1)')
    expect(approval.requests[0]?.callId).toBe('mock-tool-perm-1')
    // asked/decided 审计配对照常落盘
    expect(audit.records.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
  })

 it('rejected → reject_once 选项 id；decided 带 user-rejected 分类（词表归位）', async () => {
    const { deps, audit, approval } = makeDeps()
    approval.outcome = 'rejected'
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'selected',
      optionId: 'reject_once',
      approvalOutcome: 'rejected',
      note: 'user-rejected',
    })
  })

  it('仅 always 类允许选项 → cancelled（note allow-once-unsupported），reason 附披露，绝不选中 allow_always', async () => {
    const { deps, audit, approval } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    const alwaysOnly: acp.RequestPermissionRequest = {
      ...PARAMS,
      options: [
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    }
    const response = await handler(alwaysOnly)
 // 一次性选择绝不升格 allow_always——无 once-kind 即 cancelled（对 agent 不授权）
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.requests[0]?.reason).toContain(ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE)
    expect(approval.requests[0]?.reason).not.toContain(ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE)
    const decided = decidedDataOf(audit.records[1])
    expect(decided).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'allowed-once',
      note: 'allow-once-unsupported',
    })
    expect('optionId' in decided).toBe(false)
    // asked 审计仍完整保留 agent 原始选项列表（审计不丢信息）
    expect(askedDataOf(audit.records[0]).options).toEqual(alwaysOnly.options)
  })

  it('allow 侧完全无 allow 类选项 → cancelled（note allow-once-unsupported）并记日志', async () => {
    const { deps, audit, logs } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    const response = await handler({
      ...PARAMS,
      options: [
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
      ],
    })
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'allowed-once',
      note: 'allow-once-unsupported',
    })
    expect(logs.some((line) => line.includes('no once-kind allow option'))).toBe(true)
  })

  it('allow 侧只给未知 kind 选项 → cancelled（未知 kind 永不入选）', async () => {
    const { deps, audit } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    const response = await handler({
      ...PARAMS,
      options: [
        { optionId: 'go', name: 'Go ahead', kind: 'unknown-custom-kind' as acp.PermissionOptionKind },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    })
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'allowed-once',
      note: 'allow-once-unsupported',
    })
  })

  it('仅 always 类拒绝选项 → cancelled（note reject-once-unsupported），绝不升格 reject_always', async () => {
    const { deps, audit, approval } = makeDeps()
    approval.outcome = 'rejected'
    const handler = createAcpPermissionHandler(deps)
    const response = await handler({
      ...PARAMS,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
      ],
    })
 // 用户拒绝无法忠实表达时绝不升级为永久拒绝；cancelled 对 agent 同样不授权
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.requests[0]?.reason).toContain(ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE)
    const decided = decidedDataOf(audit.records[1])
    expect(decided).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'rejected',
      note: 'reject-once-unsupported',
    })
    expect('optionId' in decided).toBe(false)
  })

  it('reject 侧完全无 reject 类选项 → cancelled（note reject-once-unsupported）并记日志', async () => {
    const { deps, audit, approval, logs } = makeDeps()
    approval.outcome = 'rejected'
    const handler = createAcpPermissionHandler(deps)
    const response = await handler({
      ...PARAMS,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
      ],
    })
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'rejected',
      note: 'reject-once-unsupported',
    })
    expect(logs.some((line) => line.includes('no once-kind reject option'))).toBe(true)
  })

  it('reject 侧只给未知 kind 选项 → cancelled（未知 kind 永不入选）', async () => {
    const { deps, audit, approval } = makeDeps()
    approval.outcome = 'rejected'
    const handler = createAcpPermissionHandler(deps)
    const response = await handler({
      ...PARAMS,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'stop', name: 'Stop it', kind: 'unknown-custom-kind' as acp.PermissionOptionKind },
      ],
    })
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'rejected',
      note: 'reject-once-unsupported',
    })
  })

 it('always-only agent 无任何授权落点：同 turn 每次请求都重新问审批且都答 cancelled', async () => {
    const { deps, audit, approval } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    const alwaysOnly: acp.RequestPermissionRequest = {
      ...PARAMS,
      options: [
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    }
 // 桥不缓存授权、也从不替用户选 always——每次请求都完整走审批与审计，
    // 且结局恒为 cancelled（不授权），任何一次都不返回 always 类 optionId。
    expect(await handler(alwaysOnly)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await handler(alwaysOnly)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.requests).toHaveLength(2)
    expect(approval.requests.every((req) => req.reason?.includes(ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE))).toBe(true)
    const decideds = audit.records.map((record) => record.data).filter(isPermissionDecidedAudit)
    expect(decideds).toHaveLength(2)
    expect(decideds.every((data) => data.outcome === 'cancelled' && data.note === 'allow-once-unsupported' && !('optionId' in data))).toBe(true)
  })

  it('dsh cancelled → cancelled 回包（decided 记 note cancelled）', async () => {
    const { deps, audit, approval } = makeDeps()
    approval.outcome = 'cancelled'
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'cancelled',
      note: 'cancelled',
    })
  })

  it('dsh unavailable → cancelled 回包（note approval-unavailable）', async () => {
    const { deps, audit, approval } = makeDeps()
    approval.outcome = 'unavailable'
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'unavailable',
      note: 'approval-unavailable',
    })
  })

  it('signal 透传给 approval.request；abort 后审批结局 cancelled → cancelled 回包', async () => {
    const controller = new AbortController()
    const { deps, approval } = makeDeps({ turnSignal: controller.signal })
    approval.handler = (req) =>
      new Promise<AcpApprovalOutcome>((resolve) => {
        req.signal?.addEventListener('abort', () => {
          resolve('cancelled')
        }, { once: true })
      })
    const handler = createAcpPermissionHandler(deps)
    const pending = handler(PARAMS)
    await waitFor(() => approval.requests.length === 1)
    expect(approval.requests[0]?.signal).toBe(controller.signal)
    controller.abort()
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

 it('审批挂起且 turn 存活 → 桥忠实等待不伪造答复；abort 到达才结算 cancelled（④a）', async () => {
    // UI 断开的 DSH 原生语义：未答问题是 durable pending（重连 replay），不自动
    // 取消。桥镜像该语义——服务在场但无人应答期间不擅自答 cancelled/allow；
    // 只有 turn abort 才结算（真实 ApprovalService 自身 race signal 并丢弃迟到
    // 答复，此 fake 复刻该接口行为）。
    const controller = new AbortController()
    const { deps, audit, approval } = makeDeps({ turnSignal: controller.signal })
    approval.handler = (req) =>
      new Promise<AcpApprovalOutcome>((resolve) => {
        req.signal?.addEventListener('abort', () => {
          resolve('cancelled')
        }, { once: true })
      })
    const handler = createAcpPermissionHandler(deps)
    const pending = handler(PARAMS)
    await waitFor(() => approval.requests.length === 1)
    const race = await Promise.race([Promise.resolve(pending).then(() => 'answered' as const), sleep(50).then(() => 'pending' as const)])
    expect(race).toBe('pending')
    expect(audit.records.map((record) => record.data.phase)).toEqual(['asked'])
    controller.abort()
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'cancelled',
      note: 'cancelled',
    })
  })

  it('同 turn 连续两次请求的审计按序落盘且 requestId 各自配对', async () => {
    const { deps, audit } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    await handler(PARAMS)
    await handler(PARAMS)
    expect(audit.records.map((record) => record.data.phase)).toEqual(['asked', 'decided', 'asked', 'decided'])
    // 两对审计的 requestId 不同
    expect(askedDataOf(audit.records[0]).requestId).not.toBe(askedDataOf(audit.records[2]).requestId)
    // 时间戳由注入时钟打好且单调
    expect(audit.records.map((record) => record.time)).toEqual([
      TIME_BASE + 1,
      TIME_BASE + 2,
      TIME_BASE + 3,
      TIME_BASE + 4,
    ])
  })
})

describe('createAcpPermissionHandler fail closed', () => {
  it('turn 外到达 → cancelled、不落审计、不问审批、记日志', async () => {
    const { deps, audit, approval, logs } = makeDeps({ hasOpenTurn: false })
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(audit.records).toHaveLength(0)
    expect(approval.requests).toHaveLength(0)
    expect(logs.some((line) => line.includes('outside an open turn'))).toBe(true)
  })

  it('approval 服务缺席（UI 不可用）→ cancelled，asked/decided 仍落审计', async () => {
    const { deps, audit, logs } = makeDeps({ includeApproval: false })
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(audit.records).toHaveLength(2)
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'unavailable',
      note: 'approval-unavailable',
    })
    expect(logs.some((line) => line.includes('no approval service'))).toBe(true)
  })

  it('approval 服务抛错 → cancelled（note approval-error）并记日志', async () => {
    const { deps, audit, approval, logs } = makeDeps()
    approval.handler = () => {
      throw new Error('answerer exploded')
    }
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'unavailable',
      note: 'approval-error',
    })
    expect(logs.some((line) => line.includes('approval service threw'))).toBe(true)
  })

  it('asked 审计落盘失败 → cancelled 且不问审批', async () => {
    const { deps, audit, approval, logs } = makeDeps()
    audit.failOnAppend = 0
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.requests).toHaveLength(0)
    expect(audit.records).toHaveLength(0)
    expect(logs.some((line) => line.includes('asked audit append failed'))).toBe(true)
  })

  it('decided 审计落盘失败 → 即便审批通过也 cancelled（不落审计的决定不回包）', async () => {
    const { deps, audit, approval, logs } = makeDeps()
    audit.failOnAppend = 1
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(approval.requests).toHaveLength(1)
    expect(audit.records).toHaveLength(1)
    expect(logs.some((line) => line.includes('decided audit append failed'))).toBe(true)
  })
})

describe('buildPermissionReason', () => {
  it('reason 自包含地带有界标题和命令；不重复完整路径', () => {
    const reason = buildPermissionReason(PARAMS)
    expect(reason).toContain('工具：Run: echo hello')
    expect(reason).toContain('命令：echo hello')
    expect(reason).not.toContain('/work/a.txt')

    const bare = buildPermissionReason({
      sessionId: 's',
      toolCall: { toolCallId: 'tc-1' },
      options: PERMISSION_OPTIONS,
    })
    expect(bare).toBe('ACP Agent 请求执行一项需要额外权限的操作。')
    // 四 kind 齐备 → 无可用性披露
    expect(bare).not.toContain(ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE)
    expect(bare).not.toContain(ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE)
  })

  it('缺 once-kind 的一侧附可用性披露（ask 时如实告知将被视为取消）', () => {
    // 缺 allow_once：仅披露 allow 侧
    const noAllowOnce = buildPermissionReason({
      sessionId: 's',
      toolCall: { toolCallId: 'tc-3' },
      options: [
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    })
    expect(noAllowOnce).toContain(`注意：${ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE}`)
    expect(noAllowOnce).not.toContain(ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE)

    // 缺 reject_once：仅披露 reject 侧
    const noRejectOnce = buildPermissionReason({
      sessionId: 's',
      toolCall: { toolCallId: 'tc-4' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    })
    expect(noRejectOnce).not.toContain(ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE)
    expect(noRejectOnce).toContain(`注意：${ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE}`)

    // 两侧都缺（如仅 always 类）：两行披露都在
    const neitherOnce = buildPermissionReason({
      sessionId: 's',
      toolCall: { toolCallId: 'tc-5' },
      options: [
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
      ],
    })
    expect(neitherOnce).toContain(ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE)
    expect(neitherOnce).toContain(ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE)
  })

  it('rawInput 与 secret 不进入 reason（审计仍走独立脱敏摘要）', () => {
    const reason = buildPermissionReason({
      sessionId: 's',
      toolCall: {
        toolCallId: 'tc-2',
        title: 'Big',
        rawInput: { command: 'x'.repeat(500), token: 'super-secret-value' },
      },
      options: PERMISSION_OPTIONS,
    })
    expect(reason).toContain('工具：Big')
    expect(reason).toContain('详情：')
    expect(reason).not.toContain('super-secret-value')
    expect(reason.length).toBeLessThan(500)
  })

  it('execute 命令中的 env/header/curl secret 一律有界脱敏', () => {
    const reason = buildPermissionReason({
      sessionId: 's',
      toolCall: {
        toolCallId: 'tc-secrets',
        kind: 'execute',
        rawInput: {
          command: 'OPENAI_API_KEY=env-secret FOO_TOKEN=token-secret curl -H "Authorization: Bearer header-secret" --api-key option-secret https://example.test',
        },
      },
      options: PERMISSION_OPTIONS,
    })
    for (const secret of ['env-secret', 'token-secret', 'header-secret', 'option-secret']) expect(reason).not.toContain(secret)
    expect(reason).toContain('OPENAI_API_KEY=<redacted>')
    expect(reason).toContain('FOO_TOKEN=<redacted>')
    expect(reason).toContain('Authorization: Bearer <redacted>')
    expect(reason).toContain('--api-key=<redacted>')
  })

  it('quoted env/option secret 也不进入 reason', () => {
    const reason = buildPermissionReason({
      sessionId: 's',
      toolCall: {
        toolCallId: 'tc-quoted-secrets',
        kind: 'execute',
        rawInput: { command: `OPENAI_API_KEY="quoted-secret" --api-key 'quoted-option'` },
      },
      options: PERMISSION_OPTIONS,
    })
    expect(reason).not.toContain('quoted-secret')
    expect(reason).not.toContain('quoted-option')
    expect(reason).toContain('OPENAI_API_KEY=<redacted>')
    expect(reason).toContain('--api-key=<redacted>')
  })

  it('command JSON 的 quoted/unquoted secret property 只保留键名', () => {
    const reason = buildPermissionReason({
      sessionId: 's',
      toolCall: {
        toolCallId: 'tc-json-secrets',
        kind: 'execute',
        rawInput: { command: `curl -d '{"password":"json-secret","api_key":bare-key,authorization:"header-secret"}'` },
      },
      options: PERMISSION_OPTIONS,
    })
    for (const secret of ['json-secret', 'bare-key', 'header-secret']) expect(reason).not.toContain(secret)
    expect(reason).toContain('"password":<redacted>')
    expect(reason).toContain('"api_key":<redacted>')
    expect(reason).toContain('authorization:<redacted>')
  })

  it('tool title/name 经过脱敏、控制字符净化和短长度限制；净化为空时按 kind 回退', async () => {
    const { deps, approval } = makeDeps()
    const handler = createAcpPermissionHandler(deps)
    await handler({
      ...PARAMS,
      toolCall: {
        ...PARAMS.toolCall,
        title: `\u0000${'x'.repeat(200)} password=title-secret`,
        name: 'experimental-name',
      },
    })
    const title = approval.requests[0]?.toolName ?? ''
    expect(title).not.toContain('title-secret')
    expect(title).not.toContain('\u0000')
    expect(title.length).toBeLessThanOrEqual(80)

    approval.requests.length = 0
    await handler({
      ...PARAMS,
      toolCall: { ...PARAMS.toolCall, title: '\u0000\u0001', name: '   ' },
    })
    expect(approval.requests[0]?.toolName).toBe('运行命令')
  })

  it('无配对 tool-call 时仍展示脱敏的 edit 目标；超长绝对路径只保留尾段', () => {
    const path = `/Users/test/${'very-long/'.repeat(30)}secret.txt`
    const reason = buildPermissionReason({
      sessionId: 's',
      toolCall: { toolCallId: 'tc-edit', kind: 'edit', rawInput: { file_path: path, token: 'do-not-show' } },
      options: PERMISSION_OPTIONS,
    })
    expect(reason).toContain('目标：…/')
    expect(reason).toContain('secret.txt')
    expect(reason).not.toContain(path)
    expect(reason).not.toContain('do-not-show')
  })

  it('move 同时展示来源和目标；只有一侧时不伪造另一侧', () => {
    const reason = buildPermissionReason({
      sessionId: 's',
      toolCall: {
        toolCallId: 'tc-move',
        kind: 'move',
        rawInput: { source: '/work/from.txt', destination: '/work/to.txt' },
      },
      options: PERMISSION_OPTIONS,
    })
    expect(reason).toContain('来源：…/work/from.txt')
    expect(reason).toContain('目标：…/work/to.txt')

    const oneSided = buildPermissionReason({
      sessionId: 's',
      toolCall: { toolCallId: 'tc-move-one', kind: 'move', rawInput: { destination: '/work/to.txt' } },
      options: PERMISSION_OPTIONS,
    })
    expect(oneSided).toContain('目标：…/work/to.txt')
    expect(oneSided).not.toContain('来源：')
  })
})

describe(' 审批桥指标与结构化日志字段', () => {
  it('selected 结局：approval.requested 与 approval.decided(outcome=selected) 各计一次；log 带字段', async () => {
    const metrics = new AcpMetricsRegistry({ now: () => TIME_BASE })
    const { deps, logFields } = makeDeps({ metrics })
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(metrics.snapshot().counters).toEqual([
      { name: 'acp.approval.decided', labels: { outcome: 'selected' }, value: 1 },
      { name: 'acp.approval.requested', labels: {}, value: 1 },
    ])
    // 顺利路径无日志噪音（只有 fail-closed 等分流点才落行）
    expect(logFields).toEqual([])
  })

  it('cancelled 结局（approval 服务缺席 fail closed）：decided(outcome=cancelled) 计数、result=cancelled', async () => {
    const metrics = new AcpMetricsRegistry({ now: () => TIME_BASE })
    const { deps, logFields } = makeDeps({ includeApproval: false, metrics })
    const handler = createAcpPermissionHandler(deps)
    const response = await handler(PARAMS)
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(metrics.snapshot().counters).toEqual([
      { name: 'acp.approval.decided', labels: { outcome: 'cancelled' }, value: 1 },
      { name: 'acp.approval.requested', labels: {}, value: 1 },
    ])
    expect(logFields[logFields.length - 1]).toEqual({
      operation: 'permission',
      acpSessionId: 'mock-session-1',
      result: 'cancelled',
    })
  })
})

// ---------- e2e：真 AcpClientConnection + mock permission-flow / 内联 always-only ----------
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', '..', 'mock-agent', 'mock-agent.mjs')
const SPEC_TAG = `--dsh-acp-permissions-spec-${process.pid}`
const PROMPT_BLOCKS: acp.ContentBlock[] = [{ type: 'text', text: 'Run the guarded command.' }]

// 仅提供 always 类选项的内联 agent：permission 答复记 stderr（进连接 stderr 环形缓冲）
const ALWAYS_ONLY_AGENT = `
// ${SPEC_TAG}-inline-always-only
let buf = '';
let promptId = null;
let permId = null;
function send(frame) { process.stdout.write(JSON.stringify(frame) + '\\n'); }
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === undefined && msg.id !== undefined) {
      if (msg.id === permId) {
        process.stderr.write('permission-response ' + JSON.stringify(msg.result && msg.result.outcome) + '\\n');
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      }
      continue;
    }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'always-only-agent', version: '0.0.0' } } });
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'always-only-session' } });
    } else if (msg.method === 'session/prompt') {
      promptId = msg.id;
      permId = 'perm-req-1';
      send({ jsonrpc: '2.0', id: permId, method: 'session/request_permission', params: {
        sessionId: 'always-only-session',
        toolCall: { toolCallId: 'tc-1', title: 'Run: deploy', kind: 'execute', status: 'pending', rawInput: { command: 'deploy' } },
        options: [
          { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
        ],
      } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
setInterval(() => {}, 1 << 30);
`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout')
    await sleep(5)
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

let logDir = ''
let subprocess: SubprocessSeam
let spawnSeq = 0
const liveConns = new Set<AcpClientConnection>()
const spawnedPids = new Set<number>()

function track(conn: AcpClientConnection): AcpClientConnection {
  liveConns.add(conn)
  if (conn.pid !== undefined) spawnedPids.add(conn.pid)
  return conn
}

interface E2EHandle {
  conn: AcpClientConnection
  audit: FakeAuditChannel
  approval: FakeApproval
  logPath?: string
}

/** 经真实 AcpClientConnection 接线审批桥（生产接线位于 agent.ts，此处直接 new）。 */
function connectWithBridge(
  argv: string[],
  env: Record<string, string>,
  opts: { approval?: (approval: FakeApproval) => void; turnSignal?: AbortSignal } = {},
): E2EHandle {
  const order: string[] = []
  const audit = new FakeAuditChannel(order)
  const approval = new FakeApproval(order)
  opts.approval?.(approval)
  const signal = opts.turnSignal
  const handler = createAcpPermissionHandler({
    agent: FAKE_AGENT,
    audit,
    approval,
    hasOpenTurn: () => true,
    ...(signal === undefined ? {} : { turnSignal: () => signal }),
  })
  const conn = track(
    new AcpClientConnection(
      { argv, cwd: logDir, env, subprocess },
      { onPermissionRequest: handler, eofGraceMs: 150, termGraceMs: 500 },
    ),
  )
  return { conn, audit, approval }
}

function connectPermissionMock(opts: { approval?: (approval: FakeApproval) => void; turnSignal?: AbortSignal } = {}): E2EHandle {
  spawnSeq += 1
  const logPath = path.join(logDir, `perm-mock-${String(spawnSeq)}.log`)
  const handle = connectWithBridge(
    [process.execPath, MOCK_AGENT_PATH, `${SPEC_TAG}-m${String(spawnSeq)}`],
    { MOCK_SCENARIO: 'permission-flow', MOCK_LOG: logPath },
    opts,
  )
  return { ...handle, logPath }
}

beforeAll(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-permissions-spec-'))
 // e2e 的 spawn 走共享的真实 subprocess-local 服务
  subprocess = (await sharedTestSubprocess()).seam
})

afterEach(async () => {
  for (const conn of [...liveConns]) {
    await conn.close().catch(() => {})
    liveConns.delete(conn)
  }
})

afterAll(async () => {
  for (const pid of spawnedPids) {
    await waitFor(() => isDead(pid), 3000).catch(() => {})
  }
  expect([...spawnedPids].filter((pid) => !isDead(pid))).toEqual([])
  const ps = execFileSync('ps', ['-axo', 'pid,args'], { encoding: 'utf8' })
  expect(ps.split('\n').filter((line) => line.includes(SPEC_TAG))).toEqual([])
  fs.rmSync(logDir, { recursive: true, force: true })
})

describe('e2e：真 AcpClientConnection + permission-flow', () => {
  it('allowed-once → mock 收到 allow_once，turn 完成；审计两阶段经真协议帧落盘', async () => {
    const { conn, audit, logPath } = connectPermissionMock()
    await conn.initialize()
    const session = await conn.newSession()
    const updates: acp.SessionNotification[] = []
    const response = await conn.prompt(session.sessionId, PROMPT_BLOCKS, (notification) => updates.push(notification))

    expect(response.stopReason).toBe('end_turn')
    expect(fs.readFileSync(logPath ?? '', 'utf8')).toContain('permission outcome=selected optionId=allow_once')
    expect(
      updates.some(
        (n) => n.update.sessionUpdate === 'agent_message_chunk'
          && n.update.content.type === 'text'
          && n.update.content.text === 'Command finished.',
      ),
    ).toBe(true)

    expect(audit.records).toHaveLength(2)
    const asked = audit.records[0]
    expect(asked?.kind).toBe(ACP_PERMISSION_AUDIT_KIND)
    const askedData = askedDataOf(asked)
    expect(askedData.agentSessionId).toBe(session.sessionId)
    expect(askedData.toolCall).toMatchObject({
      toolCallId: 'mock-tool-perm-1',
      title: 'Run: echo hello',
      kind: 'execute',
      // rawInput 落脱敏摘要 + 哈希，不落原文
      rawInputSummary: '{"command":"echo hello"}',
    })
    expect(askedData.toolCall.rawInputHash).toMatch(/^[0-9a-f]{16}$/)
    expect(askedData.options).toEqual(PERMISSION_OPTIONS)
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'selected',
      optionId: 'allow_once',
      approvalOutcome: 'allowed-once',
    })
  })

  it('rejected → mock 收到 reject_once，turn 以 Permission denied 收尾', async () => {
    const { conn, logPath } = connectPermissionMock({ approval: (approval) => { approval.outcome = 'rejected' } })
    await conn.initialize()
    const session = await conn.newSession()
    const updates: acp.SessionNotification[] = []
    const response = await conn.prompt(session.sessionId, PROMPT_BLOCKS, (notification) => updates.push(notification))

    expect(response.stopReason).toBe('end_turn')
    expect(fs.readFileSync(logPath ?? '', 'utf8')).toContain('permission outcome=selected optionId=reject_once')
    expect(
      updates.some(
        (n) => n.update.sessionUpdate === 'agent_message_chunk'
          && n.update.content.type === 'text'
          && n.update.content.text === 'Permission denied.',
      ),
    ).toBe(true)
  })

  it('turn abort → 审批挂起被撤回，mock 收到 cancelled，stopReason cancelled', async () => {
    const controller = new AbortController()
    const { conn, approval, logPath } = connectPermissionMock({
      turnSignal: controller.signal,
      approval: (fake) => {
        fake.handler = (req) =>
          new Promise<AcpApprovalOutcome>((resolve) => {
            req.signal?.addEventListener('abort', () => {
              resolve('cancelled')
            }, { once: true })
          })
      },
    })
    await conn.initialize()
    const session = await conn.newSession()
    const pending = conn.prompt(session.sessionId, PROMPT_BLOCKS)
    await waitFor(() => approval.requests.length === 1)
    controller.abort()
    const response = await pending

    expect(response.stopReason).toBe('cancelled')
    expect(fs.readFileSync(logPath ?? '', 'utf8')).toContain('permission outcome=cancelled')
  })

 it('dispose 次序（turn abort → 结算 → close）：挂起审批以 cancelled 结案，close 返回不悬挂（④d）', async () => {
    // 插件卸载/agent dispose 的 compat 拆除链：cancel({kind:'disposed'}) →
    // whenIdle → scope.dispose → conn.close 杀子进程。本测试在连接层复刻该
    // 次序：abort 先结算审批（桥答 cancelled），close 须正常返回；即便回包与
    // 关流竞速落败，子进程死亡也结算 agent 侧挂起请求（pid 死亡 afterAll 断言）。
    const controller = new AbortController()
    const { conn, audit, approval, logPath } = connectPermissionMock({
      turnSignal: controller.signal,
      approval: (fake) => {
        fake.handler = (req) =>
          new Promise<AcpApprovalOutcome>((resolve) => {
            req.signal?.addEventListener('abort', () => {
              resolve('cancelled')
            }, { once: true })
          })
      },
    })
    await conn.initialize()
    const session = await conn.newSession()
    const pending = conn.prompt(session.sessionId, PROMPT_BLOCKS)
    await waitFor(() => approval.requests.length === 1)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(fs.readFileSync(logPath ?? '', 'utf8')).toContain('permission outcome=cancelled')
    expect(decidedDataOf(audit.records[1])).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'cancelled',
      note: 'cancelled',
    })
    await conn.close()
  })

 it('always-only agent（内联）→ cancelled 回包（note allow-once-unsupported），绝不选中 allow_always', async () => {
    const { conn, audit } = connectWithBridge([process.execPath, '-e', ALWAYS_ONLY_AGENT], {})
    await conn.initialize()
    const session = await conn.newSession()
    const response = await conn.prompt(session.sessionId, PROMPT_BLOCKS)

    // 内联 agent 无论回包如何都以 end_turn 收尾；关键断言在回包内容与审计上
    expect(response.stopReason).toBe('end_turn')
    expect(conn.stderrLines().some((line) => line.includes('"outcome":"cancelled"'))).toBe(true)
    expect(conn.stderrLines().some((line) => line.includes('allow_always') && line.includes('"selected"'))).toBe(false)
    const decided = decidedDataOf(audit.records[1])
    expect(decided).toMatchObject({
      outcome: 'cancelled',
      approvalOutcome: 'allowed-once',
      note: 'allow-once-unsupported',
    })
    expect('optionId' in decided).toBe(false)
  })
})
