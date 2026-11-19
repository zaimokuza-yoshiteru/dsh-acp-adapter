import { afterEach, expect, it, vi } from 'vitest'
import { createLiveTeamProgress, hasTeamCalculationResult, includesReadTask } from '../../e2e/live-team-progress.ts'

afterEach(() => vi.useRealTimers())

it('checks the calculation separately from the token and task IDs', () => {
  const token = 'TEAM_22abc022'
  expect(hasTeamCalculationResult(token, token)).toBe(false)
  expect(hasTeamCalculationResult(`${token}: See task-2`, token)).toBe(false)
  expect(hasTeamCalculationResult(`${token}: 20`, token)).toBe(false)
  expect(hasTeamCalculationResult(`${token}: -2`, token)).toBe(false)
  expect(hasTeamCalculationResult(`${token}: 2.5`, token)).toBe(false)
  expect(hasTeamCalculationResult('1+1 = 2', token)).toBe(false)
  expect(hasTeamCalculationResult(`${token}: 1+1 = **2**.`, token)).toBe(true)
  expect(hasTeamCalculationResult(`Result: 2.0. Token: ${token}`, token)).toBe(true)
})

it('counts a successful get or listing only when it returns the current task', () => {
  const subject = 'Compute TEAM_22abc022'
  const compute = { subject }
  const review = { subject: 'Review TEAM_22abc022' }
  expect(includesReadTask('team_task_get', compute, subject)).toBe(true)
  expect(includesReadTask('team_task_list', { tasks: [review, compute] }, subject)).toBe(true)
  expect(includesReadTask('team_task_get', review, subject)).toBe(false)
  expect(includesReadTask('team_task_list', { tasks: [review] }, subject)).toBe(false)
  expect(includesReadTask('team_task_list', { tasks: [] }, subject)).toBe(false)
  expect(includesReadTask('team_task_create', compute, subject)).toBe(false)
})

it('fails at the next observation of an error instead of waiting for the scenario timeout', async () => {
  vi.useFakeTimers()
  const progress = createLiveTeamProgress()
  const check = vi.fn(() => {
    throw new Error('waiting for a child')
  })
  const result = progress.wait(check, { timeout: 120_000, interval: 500 }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(500)
  const checksBeforeFailure = check.mock.calls.length
  progress.observe({ kind: 'error', error: { code: 'ACP_SPAWN_FAILURE', message: 'sensitive raw diagnostic' } })
  await vi.advanceTimersByTimeAsync(500)
  const error = await result
  expect(error).toMatchObject({ message: 'Live Teams turn failed (ACP_SPAWN_FAILURE)' })
  expect(checksBeforeFailure).toBeGreaterThan(0)
  expect(check).toHaveBeenCalledTimes(checksBeforeFailure)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains the first error even if a subsequent turn completes before the wait starts', async () => {
  const progress = createLiveTeamProgress()
  progress.observe({ kind: 'error', error: { code: 'FIRST', message: 'first' } })
  progress.observe({ kind: 'completed' })
  progress.observe({ kind: 'error', error: { code: 'SECOND', message: 'second' } })
  const check = vi.fn()
  await expect(progress.wait(check, { timeout: 120_000, interval: 500 })).rejects.toThrow('FIRST')
  expect(check).not.toHaveBeenCalled()
})

it('waits through completed turns for a later automatic message-driven continuation', async () => {
  vi.useFakeTimers()
  const progress = createLiveTeamProgress()
  let relayReceived = false
  progress.observe({ kind: 'completed' })
  const result = progress.wait(() => expect(relayReceived).toBe(true), { timeout: 120_000, interval: 500 })
  await vi.advanceTimersByTimeAsync(500)
  progress.observe({ kind: 'completed' })
  relayReceived = true
  await vi.advanceTimersByTimeAsync(500)
  await result
  expect(vi.getTimerCount()).toBe(0)
})

it('does not retry an out-of-scope permission from the before-check hook', async () => {
  const progress = createLiveTeamProgress()
  const check = vi.fn()
  const before = vi.fn(async () => {
    throw new Error('LIVE_TEAM_PERMISSION_TOOL_OUT_OF_SCOPE')
  })
  await expect(progress.wait(check, { timeout: 120_000, interval: 500 }, before)).rejects.toThrow('OUT_OF_SCOPE')
  expect(before).toHaveBeenCalledOnce()
  expect(check).not.toHaveBeenCalled()
})

it('preserves a later permission-check failure after an earlier polling assertion failed', async () => {
  const progress = createLiveTeamProgress()
  const original = new Error('LIVE_TEAM_PERMISSION_INPUT_CHANGED')
  const before = vi.fn(async () => {
    if (before.mock.calls.length > 1) throw original
  })
  const check = vi.fn(() => {
    throw new Error('older missing-subagent assertion')
  })
  await expect(progress.wait(check, { timeout: 120_000, interval: 1 }, before)).rejects.toBe(original)
  expect(check).toHaveBeenCalledOnce()
  expect(before).toHaveBeenCalledTimes(2)
})
