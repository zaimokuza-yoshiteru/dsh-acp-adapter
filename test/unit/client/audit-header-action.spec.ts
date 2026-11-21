import { describe, expect, it } from 'vitest'
import type { AcpAuditTimelineEntry } from '../../../src/contract/remote.ts'
import { auditTimelineRowOf } from '../../../src/host/composition/audit-row.ts'
import {
  auditEntryMatchesFilter,
  auditEntryMatchesQuery,
  auditHeaderVisible,
  auditProjectionProvider,
  auditSessionRefreshKeyOf,
  auditSummaryOf,
  auditRecordedCause,
  createAcpAuditView,
} from '../../../src/client/ui/AcpAuditHeaderAction.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'
import { acpJsonTreeLabels } from '../../../src/client/ui/json-tree.ts'

const entry = (partial: Partial<AcpAuditTimelineEntry>): AcpAuditTimelineEntry => ({
  seq: 1,
  time: 1,
  kind: 'permission',
  severity: 'info',
  category: 'permission',
  summaryCode: 'permission.decided',
  subject: null,
  status: null,
  detail: null,
  ...partial,
})
const owns = (provider: string | undefined): boolean => provider === 'acp-codex'

describe('ACP audit header utility behavior', () => {
  it('searches explicit recorded causes and does not fabricate missing or truncated causes', () => {
    const missing = entry({ detail: '{"outcome":"error"}', severity: 'error' })
    expect(auditRecordedCause(missing)).toBeNull()
    const recorded = entry({ detail: '{"reason":"not-found"}', severity: 'error' })
    expect(auditRecordedCause(recorded)).toBe('not-found')
    expect(auditEntryMatchesQuery((key) => en[key], recorded, 'not-found')).toBe(true)
    expect(auditRecordedCause(entry({ detail: '{"reason":"unfinished' }))).toBeNull()
    expect(
      auditRecordedCause(
        entry({ detail: '{"items":[{"reason":"cursor unavailable"},{"reason":"cursor unavailable"}]}' }),
      ),
    ).toBe('cursor unavailable')
  })
  it('is visible only for an established ACP backend', () => {
    expect(auditHeaderVisible({ state: 'blank' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'openai' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'acp-retired', acpBinding: true }, owns)).toBe(true)
    expect(auditHeaderVisible({ state: 'established', provider: 'acp-retired' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'draft', provider: 'acp-codex' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'acp-codex' }, owns)).toBe(true)
  })

  it('rejects native or incomplete model projections before any ACP lookup', () => {
    expect(owns(auditProjectionProvider({ lastUsed: { provider: 'openai', model: 'x' }, next: null }))).toBe(false)
    expect(owns(auditProjectionProvider({ lastUsed: null, next: { provider: 'acp-codex', model: 'x' } }))).toBe(false)
    expect(owns(auditProjectionProvider({ lastUsed: { provider: 'acp-codex', model: 'x' }, next: null }))).toBe(true)
    expect(owns(auditProjectionProvider(undefined))).toBe(false)
  })

  it('changes the backend refresh key when a blank session becomes prompt-active', () => {
    const blank = {
      blank: true,
      promptAttempted: false,
      awaitingFirstTurn: false,
      running: false,
      openState: 'open',
      lastAgentError: null,
    } as const
    const active = { ...blank, blank: false, promptAttempted: true, awaitingFirstTurn: true, running: true }
    expect(auditSessionRefreshKeyOf(blank)).not.toBe(auditSessionRefreshKeyOf(active))
    expect(auditSessionRefreshKeyOf(undefined)).toBe('absent')
  })

  it('separates issues, operations and quiet technical records', () => {
    expect(auditEntryMatchesFilter(entry({ category: 'permission' }), 'operations')).toBe(true)
    expect(auditEntryMatchesFilter(entry({ category: 'permission' }), 'issues')).toBe(false)
    expect(auditEntryMatchesFilter(entry({ severity: 'error' }), 'issues')).toBe(true)
  })

  it('searches localized user-facing facts without treating raw detail JSON as primary content', () => {
    const item = entry({
      category: 'files',
      summaryCode: 'terminal.operation',
      subject: 'printf SMOKE_OK',
      status: 'exited',
      detail: '{"internalSecret":"not-a-search-target"}',
    })
    expect(auditEntryMatchesQuery((key) => zh[key], item, '终端')).toBe(true)
    expect(auditEntryMatchesQuery((key) => en[key], item, 'printf')).toBe(true)
    expect(auditEntryMatchesQuery((key) => en[key], item, 'exited')).toBe(true)
    expect(auditEntryMatchesQuery((key) => en[key], item, 'internalSecret')).toBe(false)
    expect(auditEntryMatchesQuery((key) => en[key], item, '  ')).toBe(true)
  })

  it('shows explicit permission and recovery causes stored under their original fields', () => {
    expect(auditRecordedCause(entry({ detail: '{"note":"question-service-unavailable"}' }))).toBe(
      'question-service-unavailable',
    )
    expect(auditRecordedCause(entry({ detail: '{"reason":"","cause":"auth-required"}' }))).toBe('auth-required')
  })

  it('localizes structured summary facts and keeps raw summary codes out of the UI', () => {
    const item = entry({ summaryCode: 'filesystem.operation', subject: '/tmp/file', status: 'ok' })
    const zhText = auditSummaryOf((key) => zh[key], item)
    const enText = auditSummaryOf((key) => en[key], item)
    expect(zhText).toContain('文件操作已记录')
    expect(enText).toContain('Filesystem operation recorded')
    expect(zhText).toContain('/tmp/file · 成功')
    expect(enText).toContain('/tmp/file · Succeeded')
    expect(zhText).not.toContain('filesystem.operation')
  })

  it.each([en, zh])('shows the final answer source and option separately from the AI risk judgment', (locale) => {
    const t = (key: keyof typeof en) => locale[key]
    const base = {
      schemaVersion: 2 as const,
      time: 1,
      seq: 1,
      recordId: 'row',
      dshSessionId: 'test',
      kind: 'permission' as const,
    }
    const decision = {
      phase: 'decided' as const,
      requestId: 'request',
      agentSessionId: 'agent',
      toolCallId: 'write',
      outcome: 'selected' as const,
    }
    const automatic = auditTimelineRowOf({
      ...base,
      data: { ...decision, decisionVia: 'devin-ai', selectedOptionKind: 'allow_once' },
    })
    const manual = auditTimelineRowOf({
      ...base,
      data: { ...decision, decisionVia: 'native-question', selectedOptionKind: 'reject_once' },
    })
    const high = auditTimelineRowOf({
      ...base,
      data: {
        phase: 'ai-review-result',
        requestId: 'request',
        agentSessionId: 'agent',
        toolCallId: 'write',
        attemptId: 'attempt',
        model: 'swe-2-high',
        policyVersion: '1',
        operationHash: 'digest',
        durationMs: 5,
        status: 'high',
        reason: 'May expose private documents',
      },
    })
    expect(auditSummaryOf(t, automatic)).toBe(
      [locale.auditSummaryAiDecision, 'write', locale.auditAllowOnce].join(' · '),
    )
    expect(auditSummaryOf(t, manual)).toBe(
      [locale.auditSummaryCardDecision, 'write', locale.auditRejectOnce].join(' · '),
    )
    expect(auditSummaryOf(t, high)).toBe(
      [locale.auditSummaryReviewResult, 'swe-2-high', locale.auditRiskHigh].join(' · '),
    )
    expect(auditRecordedCause(high)).toBe('May expose private documents')
  })

  it('distinguishes a CodeBuddy result block from a data-protection observation in both locales', () => {
    const base = {
      schemaVersion: 2 as const,
      time: 1,
      seq: 1,
      recordId: 'row',
      dshSessionId: 's',
      kind: 'permission' as const,
    }
    const source = {
      phase: 'codebuddy-review' as const,
      agentSessionId: 'agent',
      toolCallId: 'call',
      toolName: 'Read',
      decidedBy: 'ai' as const,
    }
    const blocked = auditTimelineRowOf({ ...base, data: { ...source, scope: 'tool_result', decision: 'deny' } })
    const protectedData = auditTimelineRowOf({ ...base, data: { ...source, scope: 'sensitive', decision: 'allow' } })
    expect(blocked.severity).toBe('warning')
    expect(protectedData.severity).toBe('info')
    expect(auditSummaryOf((key) => en[key], blocked)).toBe('CodeBuddy security review · Read · Tool result blocked')
    expect(auditSummaryOf((key) => zh[key], blocked)).toBe('CodeBuddy 安全审查 · Read · 工具结果已拦截')
    expect(auditSummaryOf((key) => en[key], protectedData)).toContain('Sensitive data protected')
    expect(auditSummaryOf((key) => zh[key], protectedData)).toContain('敏感数据已受保护')
  })

  it('does not translate Agent identifiers that happen to match status codes', () => {
    expect(
      auditSummaryOf(
        (key) => zh[key],
        entry({ summaryCode: 'permission.decided', subject: 'allow_once', status: 'allow_once' }),
      ),
    ).toBe('权限决定已记录 · allow_once · 已允许本次操作')
  })

  it('preserves unknown status values verbatim', () => {
    expect(auditSummaryOf((key) => en[key], entry({ status: 'provider-new-state' }))).toBe(
      'Permission decision recorded · provider-new-state',
    )
  })

  it('does not render the audit view without its locale seat', () => {
    const element = createAcpAuditView({} as never)({} as never)
    expect(element).not.toBeNull()
    const wrapped = element as { type: (props: unknown) => unknown; props: unknown }
    expect(typeof wrapped.type).toBe('function')
    expect(wrapped.type(wrapped.props)).toBeNull()
  })

  it('uses the locale dictionary for JSON inspector labels and action parameters', () => {
    const labels = (dictionary: typeof en) =>
      acpJsonTreeLabels((key, params) => {
        let text: string = dictionary[key]
        for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
        return text
      })
    expect(labels(en)).toMatchObject({
      copyValue: 'Copy value',
      copyFailed: 'Copy failed',
      copyButtonTitle: expect.any(Function),
    })
    expect(labels(en).copyButtonTitle('copy JSON')).toBe('Copy options: copy JSON')
    expect(labels(zh).copyValue).toBe('复制值')
    expect(labels(zh).copyButtonTitle('复制 JSON')).toBe('复制选项：复制 JSON')
  })

  it('distinguishes a terminal output read from the process exit in the visible timeline', () => {
    const item = entry({
      summaryCode: 'terminal.operation',
      category: 'files',
      subject: 'printf ok',
      status: 'output-summary',
    })
    expect(auditSummaryOf((key) => zh[key], item)).toBe('终端操作已记录 · printf ok · 已读取输出')
    expect(auditSummaryOf((key) => en[key], item)).toBe('Terminal operation recorded · printf ok · Output read')
  })

  it('localizes session-fork outcomes and fallback reasons in both languages', () => {
    const inherited = entry({
      summaryCode: 'session-fork.completed',
      category: 'agent',
      subject: 'inherited',
      status: null,
    })
    const fallback = entry({
      summaryCode: 'session-fork.completed',
      category: 'agent',
      subject: 'blank',
      status: 'seed-not-latest-semantic-boundary',
    })
    expect(auditSummaryOf((key) => zh[key], inherited)).toBe('会话分叉结果已记录 · 已继承 Agent 上下文')
    expect(auditSummaryOf((key) => en[key], inherited)).toBe('Session fork result recorded · Agent context inherited')
    expect(auditSummaryOf((key) => zh[key], fallback)).toBe(
      '会话分叉结果已记录 · 未继承 Agent 上下文 · 分叉点不是最新语义边界',
    )
    expect(auditSummaryOf((key) => en[key], fallback)).toBe(
      'Session fork result recorded · Agent context not inherited · Fork point is not the latest semantic boundary',
    )
  })
})
