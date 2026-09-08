import { describe, expect, it } from 'vitest'
import type { AcpAuditTimelineEntry } from '../../../src/contract/remote.ts'
import { auditEntryMatchesFilter, auditEntryMatchesQuery, auditHeaderVisible, auditProjectionIsAcp, auditSessionRefreshKeyOf, auditSummaryOf, auditRecordedCause } from '../../../src/client/ui/AcpAuditHeaderAction.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

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
    expect(auditEntryMatchesQuery(key => en[key], recorded, 'not-found')).toBe(true)
    expect(auditRecordedCause(entry({ detail: '{"reason":"unfinished' }))).toBeNull()
    expect(auditRecordedCause(entry({ detail: '{"items":[{"reason":"cursor unavailable"},{"reason":"cursor unavailable"}]}' }))).toBe('cursor unavailable')
  })
  it('is visible only for an established ACP backend', () => {
    expect(auditHeaderVisible({ state: 'blank' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'openai' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'draft', provider: 'acp-codex' }, owns)).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'acp-codex' }, owns)).toBe(true)
  })

  it('rejects native or incomplete model projections before any ACP lookup', () => {
    expect(auditProjectionIsAcp({ lastUsed: { provider: 'openai', model: 'x' }, next: null }, owns)).toBe(false)
    expect(auditProjectionIsAcp({ lastUsed: null, next: { provider: 'acp-codex', model: 'x' } }, owns)).toBe(false)
    expect(auditProjectionIsAcp({ lastUsed: { provider: 'acp-codex', model: 'x' }, next: null }, owns)).toBe(true)
    expect(auditProjectionIsAcp(undefined, owns)).toBe(false)
  })

  it('changes the backend refresh key when a blank session becomes prompt-active', () => {
    const blank = {
      blank: true, promptAttempted: false, awaitingFirstTurn: false,
      running: false, openState: 'open', lastAgentError: null,
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
    expect(auditRecordedCause(entry({ detail: '{"note":"question-service-unavailable"}' }))).toBe('question-service-unavailable')
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

  it('does not translate Agent identifiers that happen to match status codes', () => {
    expect(auditSummaryOf(key => zh[key], entry({ summaryCode: 'permission.decided', subject: 'allow_once', status: 'allow_once' }))).toBe('权限决定已记录 · allow_once · 已允许本次操作')
  })

  it('distinguishes a terminal output read from the process exit in the visible timeline', () => {
    const item = entry({ summaryCode: 'terminal.operation', category: 'files', subject: 'printf ok', status: 'output-summary' })
    expect(auditSummaryOf((key) => zh[key], item)).toBe('终端操作已记录 · printf ok · 已读取输出')
    expect(auditSummaryOf((key) => en[key], item)).toBe('Terminal operation recorded · printf ok · Output read')
  })

  it('localizes session-fork outcomes and fallback reasons in both languages', () => {
    const inherited = entry({ summaryCode: 'session-fork.completed', category: 'agent', subject: 'inherited', status: null })
    const fallback = entry({ summaryCode: 'session-fork.completed', category: 'agent', subject: 'blank', status: 'seed-not-latest-semantic-boundary' })
    expect(auditSummaryOf((key) => zh[key], inherited)).toBe('会话分叉结果已记录 · 已继承 Agent 上下文')
    expect(auditSummaryOf((key) => en[key], inherited)).toBe('Session fork result recorded · Agent context inherited')
    expect(auditSummaryOf((key) => zh[key], fallback)).toBe('会话分叉结果已记录 · 未继承 Agent 上下文 · 分叉点不是最新语义边界')
    expect(auditSummaryOf((key) => en[key], fallback)).toBe('Session fork result recorded · Agent context not inherited · Fork point is not the latest semantic boundary')
  })
})
