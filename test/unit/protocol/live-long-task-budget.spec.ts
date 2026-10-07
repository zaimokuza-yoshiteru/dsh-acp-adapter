import { expect, it, vi } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  admitLongTaskTool,
  createLongTaskBudget,
  LONG_TASK_BUDGET,
  longTaskEffectFingerprint,
  observeLongTaskProviderToolCall,
  recordLongTaskApprovalRequest,
  recordLongTaskToolResult,
} from '../../e2e/live-long-task-budget.ts'

it('allows two planned spawns and rejects the third before dispatch', () => {
  const budget = createLongTaskBudget()
  for (let index = 0; index < 2; index += 1) {
    expect(
      admitLongTaskTool(budget, { scene: 'B', toolName: 'spawn_teammate', callId: `spawn-${index}` }),
    ).toBeUndefined()
  }
  expect(admitLongTaskTool(budget, { scene: 'B', toolName: 'spawn_teammate', callId: 'spawn-3' })).toBe(
    'LONG_TASK_SPAWN_BUDGET',
  )
  expect(budget.totalDispatches).toBe(2)
  expect(budget.spawnAttempts).toBe(2)
})

it('allows two successful identical side effects and rejects the next attempt', () => {
  const budget = createLongTaskBudget()
  const effect = longTaskEffectFingerprint('run-secret', 'bash', { command: 'write x' })
  for (let index = 0; index < 2; index += 1) {
    const callId = `write-${index}`
    expect(
      admitLongTaskTool(budget, { scene: 'C', toolName: 'bash', callId, effectFingerprint: effect }),
    ).toBeUndefined()
    recordLongTaskToolResult(budget, callId, false)
  }
  expect(
    admitLongTaskTool(budget, { scene: 'C', toolName: 'bash', callId: 'write-3', effectFingerprint: effect }),
  ).toBe('LONG_TASK_REPEAT_EFFECT_BUDGET')
  expect(budget.successfulEffectCounts.get(effect)).toBe(2)
})

it('reserves repeat-effect allowance before concurrent Host tool bodies start', async () => {
  const ctx = new CordisContext()
  const systemPromptFiber = await ctx.plugin(SystemPrompt, {})
  const runtime = await ctx.plugin(ToolRuntime)
  const budget = createLongTaskBudget()
  let bodyCalls = 0
  let errorResults = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  ctx.tools.register(
    defineTool({
      name: 'bash',
      description: 'A gated test side effect.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => {
        bodyCalls += 1
        await held
        return 'finished'
      },
    }),
  )
  ctx.tools.guard((execution) => {
    if (execution.agent?.options.provider !== 'acp-devin') return undefined
    const effectFingerprint = longTaskEffectFingerprint('parallel-run', execution.name, execution.arguments)
    const denial = admitLongTaskTool(budget, {
      scene: 'C',
      toolName: execution.name,
      callId: String(execution.callId),
      effectFingerprint,
    })
    return denial === undefined ? undefined : 'LIVE_LONG_TASK_BUDGET'
  })
  ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.options.provider !== 'acp-devin') return
    if (result.isError) errorResults += 1
    recordLongTaskToolResult(budget, String(execution.callId), result.isError)
  })
  try {
    const calls = Array.from({ length: 3 }, (_, index) =>
      ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`parallel-${index}`),
        name: 'bash',
        arguments: { command: 'same side effect' },
        agent: { id: 'lead-session', options: { provider: 'acp-devin' } } as never,
      }),
    )
    await vi.waitFor(() => {
      expect(bodyCalls).toBe(2)
      expect(errorResults).toBe(1)
    })
    release()
    const results = await Promise.all(calls)
    expect(results.filter((result) => result.isError)).toHaveLength(1)
    expect(bodyCalls).toBe(2)
    expect(budget.pendingEffectCounts.size).toBe(0)
    expect([...budget.successfulEffectCounts.values()]).toEqual([2])
  } finally {
    release()
    await runtime.dispose()
    await systemPromptFiber.dispose()
  }
})

it('enforces scene and run dispatch caps across scene changes', () => {
  const sceneBudget = createLongTaskBudget()
  for (let index = 0; index < LONG_TASK_BUDGET.sceneDispatches; index += 1)
    expect(admitLongTaskTool(sceneBudget, { scene: 'A', toolName: 'read', callId: `scene-${index}` })).toBeUndefined()
  expect(admitLongTaskTool(sceneBudget, { scene: 'A', toolName: 'read', callId: 'scene-over' })).toBe(
    'LONG_TASK_SCENE_DISPATCH_BUDGET',
  )

  const runBudget = createLongTaskBudget()
  const scenes = ['A', 'B', 'C', 'D'] as const
  for (let index = 0; index < LONG_TASK_BUDGET.totalDispatches; index += 1) {
    const scene = scenes[index % scenes.length]
    if (scene === undefined) throw new Error('Expected a scene in the non-empty scene list')
    expect(admitLongTaskTool(runBudget, { scene, toolName: 'read', callId: `run-${index}` })).toBeUndefined()
  }
  expect(admitLongTaskTool(runBudget, { scene: 'D', toolName: 'read', callId: 'run-over' })).toBe(
    'LONG_TASK_TOTAL_DISPATCH_BUDGET',
  )
})

it('counts approval requests separately from guarded Host dispatches and fails closed', () => {
  const budget = createLongTaskBudget()
  for (let index = 0; index < LONG_TASK_BUDGET.sceneApprovalRequests; index += 1)
    expect(recordLongTaskApprovalRequest(budget, 'C')).toBeUndefined()
  expect(recordLongTaskApprovalRequest(budget, 'C')).toBe('LONG_TASK_SCENE_APPROVAL_REQUEST_BUDGET')
  expect(budget.totalDispatches).toBe(0)
  expect(recordLongTaskApprovalRequest(budget, 'D')).toBe('LONG_TASK_SCENE_APPROVAL_REQUEST_BUDGET')
})

it('deduplicates provider activity ids and marks the limit as a soft sticky violation', () => {
  const budget = createLongTaskBudget()
  for (let index = 0; index < LONG_TASK_BUDGET.providerToolCalls; index += 1)
    expect(observeLongTaskProviderToolCall(budget, `provider-${index}`)).toBe(true)
  expect(observeLongTaskProviderToolCall(budget, 'provider-0')).toBe(false)
  expect(budget.violation).toBeUndefined()
  observeLongTaskProviderToolCall(budget, 'provider-over-limit')
  expect(budget.violation).toBe('LONG_TASK_PROVIDER_TOOL_ACTIVITY_SOFT_BUDGET')
  expect(admitLongTaskTool(budget, { scene: 'D', toolName: 'bash', callId: 'later' })).toBe(
    'LONG_TASK_PROVIDER_TOOL_ACTIVITY_SOFT_BUDGET',
  )
})

it('counts an expired total deadline as a sticky pre-dispatch failure', () => {
  const budget = createLongTaskBudget(10)
  expect(
    admitLongTaskTool(budget, { scene: 'A', toolName: 'read', callId: 'late', now: 10 + LONG_TASK_BUDGET.totalMs }),
  ).toBe('LONG_TASK_TOTAL_DEADLINE')
  expect(budget.totalDispatches).toBe(0)
})
