import type * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'
import { qwenLiveCronApproval, qwenLiveCronInput } from '../../fixtures/qwen-live-cron.ts'

it('approves only one exact, current and unambiguous Qwen cron request', () => {
  const once = { kind: 'allow_once' as const, optionId: 'proceed_once', name: 'Allow' }
  const always = { kind: 'allow_always' as const, optionId: 'always', name: 'Always allow' }
  const request: acp.RequestPermissionRequest = {
    sessionId: 'scheduled',
    options: [always, once],
    toolCall: { toolCallId: 'cron', _meta: { toolName: 'cron_create' }, rawInput: qwenLiveCronInput },
  }
  const approve = qwenLiveCronApproval(() => 'scheduled')
  const cancelled = { outcome: { outcome: 'cancelled' } }
  expect(approve(request, AbortSignal.abort())).toEqual(cancelled)
  expect(approve({ ...request, sessionId: 'another' })).toEqual(cancelled)
  expect(approve({ ...request, options: [always] })).toEqual(cancelled)
  expect(approve({ ...request, options: [once, { ...always, optionId: once.optionId }] })).toEqual(cancelled)
  expect(approve({ ...request, toolCall: { ...request.toolCall, _meta: {} } })).toEqual(cancelled)
  for (const rawInput of [
    undefined,
    { ...qwenLiveCronInput, recurring: true },
    { ...qwenLiveCronInput, durable: true },
    { ...qwenLiveCronInput, sessionMode: 'per_run' },
    { ...qwenLiveCronInput, prompt: 'another prompt' },
  ])
    expect(approve({ ...request, toolCall: { ...request.toolCall, rawInput } })).toEqual(cancelled)
  expect(approve(request)).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } })
  expect(approve(request)).toEqual(cancelled)
})
