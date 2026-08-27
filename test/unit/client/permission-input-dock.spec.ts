import { describe, expect, it } from 'vitest'
import type { AcpPendingPermissionView, AcpRemoteLike } from '../../../src/client/data/acp-remote.ts'
import {
  optionKindLabel,
  pendingForSession,
  permissionLocationOmissionText,
  permissionOptionText,
  permissionOptionVariant,
  submitPermissionAnswer,
  submitPermissionCancel,
} from '../../../src/client/ui/AcpPermissionInputDock.ts'

const pending: readonly AcpPendingPermissionView[] = [
  {
    requestId: 'request-1', sessionId: 'session-a', acpSessionId: 'acp-1', toolCallId: 'tool-1',
    title: 'shell', kind: 'execute', reason: 'needs approval', createdAt: 1,
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    ],
  },
  {
    requestId: 'request-2', sessionId: 'session-a', acpSessionId: 'acp-1', toolCallId: 'tool-2',
    title: 'write', kind: 'write', reason: 'needs approval', createdAt: 2,
    options: [{ optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }],
  },
]

const t = (key: string, params?: Record<string, string | number>): string => ({
  permissionOptionAllowOnce: '允许一次',
  permissionOptionAllowAlways: '始终允许',
  permissionOptionRejectOnce: '拒绝一次',
  permissionOptionRejectAlways: '始终拒绝',
  permissionOptionUnknown: `未知(${String(params?.kind ?? '')})`,
  permissionLocationsOmitted: `另有${String(params?.count ?? '')}个位置未显示`,
}[key] ?? key)

function remoteOf(overrides: Partial<AcpRemoteLike> = {}): AcpRemoteLike {
  return {
    health: async () => ({ ok: true, value: {} as never }),
    options: async () => ({ ok: true, value: {} as never }),
    setOption: async () => ({ ok: true, value: {} as never }),
    backendOf: async () => ({ ok: true, value: {} as never }),
    rebindBlank: async () => ({ ok: true, value: {} as never }),
    boundSessions: async () => ({ ok: true, value: {} as never }),
    beginModelSwitch: async () => ({ ok: true, value: {} as never }),
    commitModelSwitch: async () => ({ ok: true, value: {} as never }),
    rollbackModelSwitch: async () => ({ ok: true, value: {} as never }),
    ...overrides,
  }
}

describe('ACP permission input.dock surface', () => {
  it('session switch never renders the previous session pending list', () => {
    expect(pendingForSession({ sessionId: 'session-a', pending }, 'session-b')).toEqual([])
    expect(pendingForSession({ sessionId: 'session-a', pending }, 'session-a')).toEqual(pending)
  })

  it('option action sends the exact Agent optionId and removes only the resolved request', async () => {
    const calls: unknown[] = []
    const remote = remoteOf({
      answerPermission: async (sessionId, request) => {
        calls.push([sessionId, request])
        return { ok: true as const, value: null }
      },
    })
    await expect(submitPermissionAnswer(remote, 'session-a', pending, pending[0]!, 'allow_always')).resolves.toEqual({
      ok: true,
      pending: [pending[1]],
    })
    expect(calls).toEqual([['session-a', { requestId: 'request-1', optionId: 'allow_always' }]])
  })

  it('Remote answer failure remains visible to the card and preserves the request', async () => {
    const result = await submitPermissionAnswer(remoteOf({
      answerPermission: async () => ({ ok: false as const, error: { message: 'bridge unavailable' } }),
    }), 'session-a', pending, pending[0]!, 'allow_once')
    expect(result).toEqual({ ok: false, message: 'bridge unavailable' })
    expect(pending).toHaveLength(2)
  })

  it('cancel sends only requestId and removes that request on success', async () => {
    const calls: unknown[] = []
    const result = await submitPermissionCancel(remoteOf({
      cancelPermission: async (sessionId, request) => {
        calls.push([sessionId, request])
        return { ok: true as const, value: null }
      },
    }), 'session-a', pending, pending[1]!)
    expect(calls).toEqual([['session-a', { requestId: 'request-2' }]])
    expect(result).toEqual({ ok: true, pending: [pending[0]] })
  })

  it('option labels are localized semantic badges and unknown kinds stay honest', () => {
    expect(optionKindLabel('allow_always', t)).toBe('始终允许')
    expect(optionKindLabel('reject_once', t)).toBe('拒绝一次')
    expect(optionKindLabel('future_kind', t)).toBe('未知(future_kind)')
  })

  it('only reversible allow-once is promoted to the DSH primary action', () => {
    expect(permissionOptionVariant('allow_once')).toBe('primary')
    expect(permissionOptionVariant('allow_always')).toBe('outline')
    expect(permissionOptionVariant('reject_once')).toBe('outline')
    expect(permissionOptionVariant('reject_always')).toBe('outline')
  })

  it('known options use one localized label while preserving unknown Agent labels', () => {
    expect(permissionOptionText(pending[0]!.options[0]!, t)).toBe('允许一次')
    expect(permissionOptionText(pending[0]!.options[1]!, t)).toBe('始终允许')
    expect(permissionOptionText({ optionId: 'ask-admin', name: 'Ask an administrator', kind: 'future_kind' }, t))
      .toBe('Ask an administrator')
  })

  it('bounded locations disclose omitted entries, including legacy count metadata', () => {
    const item = {
      ...pending[0]!,
      locations: [{ path: '/work/a.txt' }],
      locationCount: 5,
    }
    expect(permissionLocationOmissionText(item, t)).toBe('另有4个位置未显示')
    expect(permissionLocationOmissionText({ ...item, omittedLocationCount: 0 }, t)).toBeUndefined()
  })
})
