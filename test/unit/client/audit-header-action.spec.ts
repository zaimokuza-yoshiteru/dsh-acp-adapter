import { describe, expect, it } from 'vitest'
import type { AcpAuditTimelineEntry } from '../../../src/contract/remote.ts'
import { auditEntryMatchesFilter, auditHeaderVisible, auditSessionRefreshKeyOf, auditSummaryOf } from '../../../src/client/ui/AcpAuditHeaderAction.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

const entry = (partial: Partial<AcpAuditTimelineEntry>): AcpAuditTimelineEntry => ({
  seq: 1,
  time: 1,
  kind: 'permission',
  category: 'permission',
  summaryCode: 'permission.decided',
  subject: null,
  status: null,
  detail: null,
  ...partial,
})

describe('ACP audit header utility behavior', () => {
  it('is visible only for an established ACP backend', () => {
    expect(auditHeaderVisible({ state: 'blank' })).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'openai' })).toBe(false)
    expect(auditHeaderVisible({ state: 'draft', provider: 'acp-codex' })).toBe(false)
    expect(auditHeaderVisible({ state: 'established', provider: 'acp-codex' })).toBe(true)
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

  it('filters ledger rows by category without changing the paged source', () => {
    expect(auditEntryMatchesFilter(entry({ category: 'permission' }), 'permission')).toBe(true)
    expect(auditEntryMatchesFilter(entry({ category: 'permission' }), 'files')).toBe(false)
    expect(auditEntryMatchesFilter(entry({ category: 'permission' }), 'all')).toBe(true)
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

  it('does not expose internal Native Agent access and setup enums as user copy', () => {
    const access = entry({ summaryCode: 'permission-scope.recorded', subject: 'darwin', status: 'danger-full-access' })
    const setup = entry({ summaryCode: 'agent-mode.changed', subject: 'default', status: 'set_config_option' })
    expect(auditSummaryOf((key) => zh[key], access)).toContain('原生 Agent 访问')
    expect(auditSummaryOf((key) => zh[key], access)).not.toContain('danger-full-access')
    expect(auditSummaryOf((key) => zh[key], setup)).toContain('配置同步')
    expect(auditSummaryOf((key) => zh[key], setup)).not.toContain('set_config_option')
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
