import { supportsLocalApprovalReview } from '../../../src/contract/approval-review.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { ApprovalReviewScope, approvalReviewInput } from '../../../src/host/approval-review/scope.ts'
import type { AcpPermissionReviewContext } from '../../../src/runtime/session/session-runtime.ts'

const profile = { name: 'Devin', command: 'devin', args: ['acp'], env: {} }
const context: AcpPermissionReviewContext = {
  task: () => 'Fix a typo',
  toolCall: { toolCallId: 'actual', rawInput: { path: 'README.md' } },
  agent: { name: 'affogato', title: 'Devin Agent', version: '3000.14.30821' },
  humanOnly: false,
  current: () => true,
}
const cancel = { outcome: { outcome: 'cancelled' as const } }
const worker = () => ({
  review: vi.fn(async () => ({ risk: 'not_high' as const, reason: 'Reversible edit' })),
  dispose: vi.fn(async () => {}),
})

it('enables local approval review only on supported execution platforms', () => {
  expect(supportsLocalApprovalReview('darwin')).toBe(true)
  expect(supportsLocalApprovalReview('linux')).toBe(true)
  expect(supportsLocalApprovalReview('win32')).toBe(false)
})

it('sends only fully represented current user or delegated inputs to the reviewer', () => {
  const approvalReviewTask = (messages: UserMessage[]) => approvalReviewInput(messages, () => undefined).task()
  const text = (kind: string, value: string) =>
    createUserMessage({ source: { kind } as UserMessage['source'], content: [{ type: 'text', text: value }] })
  expect(
    approvalReviewTask([
      text('skill-catalog', 'workflow'),
      text('user', 'Local changes only'),
      text('agent-message', 'Fix typo'),
    ]),
  ).toBe('Local changes only\n\nDelegated message: Fix typo')
  expect(approvalReviewTask([text('runtime-context', 'background data')])).toBeUndefined()
  expect(
    approvalReviewTask([
      text('user', 'Check these'),
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'reasoning', text: 'not a task' }] }),
    ]),
  ).toBeUndefined()
})

it('preserves existing decisions when off, and never starts a reviewer for explicit Ask or another Agent', async () => {
  const spawn = vi.fn(worker)
  const scope = new ApprovalReviewScope('devin', spawn, vi.fn())
  const signal = new AbortController().signal
  await scope.handle(profile, context, 'zh-CN', signal, async (deps, life) => {
    expect(life).toBe(signal)
    expect(deps).toEqual({})
    return cancel
  })
  scope.configure(profile, 'swe-2-high')
  for (const request of [
    { ...context, humanOnly: true },
    { ...context, agent: null },
    { ...context, task: () => undefined },
  ]) {
    await scope.handle(profile, request, undefined, signal, async (deps) => {
      expect(deps).toEqual({ humanReviewOnly: request.humanOnly ? true : 'review-unavailable' })
      return cancel
    })
  }
  expect(spawn).not.toHaveBeenCalled()
  await scope.close()
})

it('routes to manual approval before any model call on an unverified execution provider', async () => {
  const seam = { resolveExecutable: vi.fn(), spawn: vi.fn() }
  const scope = ApprovalReviewScope.forProfile('devin', seam, vi.fn())
  try {
    scope.configure(profile, 'swe-2-high')
    await scope.handle(profile, context, 'en', new AbortController().signal, async (deps) => {
      expect(deps).toEqual({ humanReviewOnly: 'review-unavailable' })
      return cancel
    })
    expect(seam.resolveExecutable).not.toHaveBeenCalled()
    expect(seam.spawn).not.toHaveBeenCalled()
  } finally {
    await scope.close()
  }
})

it('keeps the native human card on Windows even with a saved opt-in, valid handshake, model and request', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const spawn = vi.fn(worker)
  const scope = new ApprovalReviewScope('devin', spawn, vi.fn())
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    scope.configure(profile, 'swe-2-high')
    await scope.handle(profile, context, 'en', new AbortController().signal, async (deps) => {
      expect(deps).toEqual({ humanReviewOnly: 'review-unavailable' })
      return cancel
    })
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    await scope.close()
  }
})

it.skipIf(process.platform === 'win32')(
  'revokes an in-flight permission when settings change, and drains its audit on shutdown',
  async () => {
    const first = worker()
    const scope = new ApprovalReviewScope('devin', () => first, vi.fn())
    const admitted = Promise.withResolvers<void>()
    const audit = Promise.withResolvers<void>()
    scope.configure(profile, 'swe-2-high')
    const operation = scope.handle(profile, context, 'zh-CN', new AbortController().signal, async (deps, signal) => {
      await deps.riskReviewer!.review(deps.riskReviewer!.toolCall!, signal)
      expect(first.review).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'Fix a typo', toolCall: context.toolCall, locale: 'zh-CN' }),
      )
      admitted.resolve()
      await audit.promise
      expect(signal.aborted).toBe(true)
      return cancel
    })
    await admitted.promise
    scope.configure(profile, 'another-model')
    expect(first.dispose).toHaveBeenCalledOnce()
    const closed = vi.fn()
    const drain = scope.close().then(closed)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    audit.resolve()
    await Promise.all([drain, operation])
    expect(closed).toHaveBeenCalledOnce()
  },
)

it.skipIf(process.platform === 'win32')(
  'uses the confirmed OpenCode model only for recognized main-session tools on the selected profile',
  async () => {
    const config = { name: 'Work', command: '/opt/tools/opencode', args: ['acp'], env: {} }
    const workerInstance = worker()
    const spawn = vi.fn((_agent: 'devin' | 'opencode') => workerInstance)
    const scope = new ApprovalReviewScope('work', spawn, vi.fn())
    const signal = new AbortController().signal
    const request = {
      ...context,
      agent: { name: 'OpenCode', version: '2.3.2' },
      toolCall: { ...context.toolCall, name: 'read' },
      verifiedActorCwd: '/tmp/work',
      sessionModel: 'private/fast',
    }
    try {
      scope.configure(config, '')
      for (const input of [
        { ...request, verifiedActorCwd: undefined },
        { ...request, sessionModel: '' },
        { ...request, sessionModel: 'unqualified' },
        { ...request, agent: { name: 'OpenCode', version: '2.3.1' } },
        { ...request, toolCall: { ...request.toolCall, name: 'question' } },
        { ...request, humanOnly: true },
      ]) {
        await scope.handle(config, input, 'en', signal, async (deps) => {
          expect(deps.humanReviewOnly).toBeTruthy()
          return cancel
        })
      }
      expect(spawn).not.toHaveBeenCalled()
      for (const model of ['', 'private/cheaper']) {
        scope.configure(config, model)
        await scope.handle(config, request, undefined, signal, async (deps) => {
          expect(deps.riskReviewer).toMatchObject({ agent: 'opencode', model: model || request.sessionModel })
          await deps.riskReviewer!.review(request.toolCall, signal)
          expect(workerInstance.review).toHaveBeenLastCalledWith(expect.objectContaining({ locale: undefined }))
          return cancel
        })
      }
      expect(spawn.mock.calls).toEqual([['opencode'], ['opencode']])
    } finally {
      await scope.close()
    }
  },
)
