import { expect, it, vi } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  createDevinLiveToolBudget,
  devinLiveWaitCondition,
  MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS,
  recordDevinLiveToolAttempt,
} from '../../../scripts/devin-live-budget.ts'

it('allows one Lead spawn and one teammate mailbox message', () => {
  const budget = createDevinLiveToolBudget()
  expect(
    recordDevinLiveToolAttempt(budget, {
      sessionKey: 'lead-session',
      role: 'lead',
      phase: 'initial',
      tool: 'spawn_teammate',
    }),
  ).toBeUndefined()
  expect(
    recordDevinLiveToolAttempt(budget, {
      sessionKey: 'member-session',
      role: 'teammate',
      phase: 'initial',
      tool: 'send_message',
    }),
  ).toBeUndefined()
})

it('rejects a Lead message and a repeated teammate message', () => {
  const leadBudget = createDevinLiveToolBudget()
  const leadMessageBody = vi.fn()
  const leadMessageDenial = recordDevinLiveToolAttempt(leadBudget, {
    sessionKey: 'lead-session',
    role: 'lead',
    phase: 'initial',
    tool: 'send_message',
  })
  if (leadMessageDenial === undefined) leadMessageBody()
  expect(leadMessageDenial).toBe('LIVE_LEAD_MESSAGE_UNEXPECTED')
  expect(leadMessageBody).not.toHaveBeenCalled()

  const memberBudget = createDevinLiveToolBudget()
  const send = {
    sessionKey: 'member-session',
    role: 'teammate' as const,
    phase: 'initial' as const,
    tool: 'send_message' as const,
  }
  recordDevinLiveToolAttempt(memberBudget, send)
  expect(recordDevinLiveToolAttempt(memberBudget, send)).toBe('LIVE_TEAMMATE_MESSAGE_BUDGET_EXCEEDED')
})

it('bounds pre-dispatch attempts and rejects tools during the explicit follow-up', () => {
  const budget = createDevinLiveToolBudget()
  for (let index = 0; index < MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS; index += 1) {
    recordDevinLiveToolAttempt(budget, {
      sessionKey: 'lead-session',
      role: 'lead',
      phase: 'initial',
      tool: 'other',
    })
  }
  expect(budget.violation).toBeUndefined()
  expect(budget.allowedDispatches).toBe(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)
  expect(budget.deniedDispatches).toBe(0)
  expect(
    recordDevinLiveToolAttempt(budget, {
      sessionKey: 'lead-session',
      role: 'lead',
      phase: 'initial',
      tool: 'other',
    }),
  ).toBe('LIVE_TOTAL_TOOL_BUDGET_EXCEEDED')
  expect(budget.allowedDispatches).toBe(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)
  expect(budget.deniedDispatches).toBe(1)

  const followupBudget = createDevinLiveToolBudget()
  expect(
    recordDevinLiveToolAttempt(followupBudget, {
      sessionKey: 'lead-session',
      role: 'lead',
      phase: 'followup',
      tool: 'other',
    }),
  ).toBe('LIVE_FOLLOWUP_TOOL_CALL_UNEXPECTED')
})

it('checks the cost guard before evaluating even an already-true wait condition', () => {
  const condition = vi.fn(() => true)
  expect(() => devinLiveWaitCondition(condition, 'LIVE_LEAD_MESSAGE_UNEXPECTED')).toThrow(
    'LIVE_LEAD_MESSAGE_UNEXPECTED',
  )
  expect(condition).not.toHaveBeenCalled()
  expect(devinLiveWaitCondition(condition, undefined)).toBe(true)
  expect(condition).toHaveBeenCalledOnce()
})

it('fails closed when the actor phase is not yet classified', () => {
  const budget = createDevinLiveToolBudget()
  expect(
    recordDevinLiveToolAttempt(budget, {
      sessionKey: 'unclassified-session',
      role: 'lead',
      phase: 'unknown',
      tool: 'other',
    }),
  ).toBe('LIVE_TOOL_PHASE_UNCLASSIFIED')
  expect(budget.allowedDispatches).toBe(0)
  expect(budget.deniedDispatches).toBe(1)
})

it('admits at most sixteen concurrent dispatch attempts before denying the rest', async () => {
  const budget = createDevinLiveToolBudget()
  const decisions = await Promise.all(
    Array.from({ length: MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS + 4 }, (_, index) =>
      Promise.resolve().then(() =>
        recordDevinLiveToolAttempt(budget, {
          sessionKey: `lead-${index}`,
          role: 'lead',
          phase: 'initial',
          tool: 'other',
        }),
      ),
    ),
  )
  expect(decisions.slice(0, MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)).toEqual(
    Array(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS).fill(undefined),
  )
  expect(decisions.slice(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)).toEqual(Array(4).fill('LIVE_TOTAL_TOOL_BUDGET_EXCEEDED'))
  expect(budget.allowedDispatches).toBe(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)
  expect(budget.deniedDispatches).toBe(4)
})

it('uses the Host ToolRuntime guard to deny prohibited Lead messages before the tool body', async () => {
  const ctx = new CordisContext()
  const systemPromptFiber = await ctx.plugin(SystemPrompt, {})
  const runtimeFiber = await ctx.plugin(ToolRuntime)
  let bodyCalls = 0
  ctx.tools.register(
    defineTool({
      name: 'send_message',
      description: 'Send a Team message.',
      parameters: { target: { type: 'string', required: true }, message: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('queued')
      },
    }),
  )
  const budget = createDevinLiveToolBudget()
  ctx.tools.guard((execution) => {
    if (execution.agent?.options.provider !== 'acp-devin') return undefined
    const violation = recordDevinLiveToolAttempt(budget, {
      sessionKey: execution.agent.id,
      role: 'lead',
      phase: 'initial',
      tool: execution.name === 'send_message' ? 'send_message' : 'other',
    })
    return violation === undefined ? undefined : 'LIVE_TOOL_BUDGET'
  })
  try {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('prohibited-lead-message'),
      name: 'send_message',
      arguments: { target: 'lead', message: 'marker' },
      agent: { id: 'lead-0', options: { provider: 'acp-devin' } } as never,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: LIVE_TOOL_BUDGET' }])
    expect(bodyCalls).toBe(0)
    expect(budget.allowedDispatches).toBe(0)
    expect(budget.deniedDispatches).toBe(1)
  } finally {
    await runtimeFiber.dispose()
    await systemPromptFiber.dispose()
  }
})

it('caps real concurrent Host tool bodies at sixteen admissions', async () => {
  const ctx = new CordisContext()
  const systemPromptFiber = await ctx.plugin(SystemPrompt, {})
  const runtimeFiber = await ctx.plugin(ToolRuntime)
  let bodyCalls = 0
  ctx.tools.register(
    defineTool({
      name: 'probe',
      description: 'Count a harmless Host tool execution.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => {
        bodyCalls += 1
        return Promise.resolve('ran')
      },
    }),
  )
  const budget = createDevinLiveToolBudget()
  ctx.tools.guard((execution) => {
    if (execution.agent?.options.provider !== 'acp-devin') return undefined
    const violation = recordDevinLiveToolAttempt(budget, {
      sessionKey: execution.agent.id,
      role: 'lead',
      phase: 'initial',
      tool: 'other',
    })
    return violation === undefined ? undefined : 'LIVE_TOOL_BUDGET'
  })
  try {
    const results = await Promise.all(
      Array.from({ length: MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS + 4 }, (_, index) =>
        ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`probe-${index}`),
          name: 'probe',
          arguments: {},
          agent: { id: 'lead-0', options: { provider: 'acp-devin' } } as never,
        }),
      ),
    )
    expect(results.filter((result) => result.isError)).toHaveLength(4)
    expect(bodyCalls).toBe(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)
    expect(budget.allowedDispatches).toBe(MAX_DEVIN_LIVE_DISPATCH_ATTEMPTS)
    expect(budget.deniedDispatches).toBe(4)
  } finally {
    await runtimeFiber.dispose()
    await systemPromptFiber.dispose()
  }
})
