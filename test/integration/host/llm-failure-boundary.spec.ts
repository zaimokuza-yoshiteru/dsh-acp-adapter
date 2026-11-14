import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { AcpSessionFacts, acpSessionView } from '../../../src/host/composition/session-facts.ts'
import { AcpClientError } from '../../../src/protocol/v1/errors.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe('ACP failures through the published LLM and AgentLoop boundary', () => {
  it.each(['ACP_TIMEOUT', 'ACP_LOCAL_SETTLEMENT_FAILED'] as const)(
    'retains %s in request recovery and the Session without redispatch',
    async (code) => {
      const root = mkdtempSync(join(tmpdir(), 'acp-llm-failure-'))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const sidecar = createAcpSidecar({ root })
      cleanup.push(() => sidecar.dispose())
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      await ctx.plugin(AcpSessionFacts)
      await ctx.plugin(LlmRetry, {})
      const driver = await mountAgentLoopTestHarness(ctx)
      const providerFacts = {
        message: 'The Agent completed but the local result is not durable',
        code: 'ACP_LOCAL_SETTLEMENT_FAILED',
        status: 503,
        providerRetryAfterMs: 20,
        requestId: ProviderRequestId('acp-settlement-request'),
      }
      const failure =
        code === 'ACP_TIMEOUT'
          ? new AcpClientError('timeout', 'ACP prompt outcome is not confirmed')
          : LlmError.fromFailure(providerFacts, { cause: new Error('local storage failed') })
      const prompt = vi.fn(async () => {
        throw failure
      })
      const adapter = new AcpProfileAdapter(
        'test',
        () => ({ name: 'Boundary fixture', command: 'unused-test-agent', args: [], env: {} }),
        {
          ok: true,
          seam: {
            resolveExecutable: async (command) => command,
            spawn: () => {
              throw new Error('the scripted runtime must not spawn')
            },
          },
        },
        (id) => acpSessionView(ctx, ctx.sessions.get(SessionId(id))),
        {
          begin: (record) => sidecar.beginDispatch(record),
          read: (id, key) => sidecar.readDispatch(SessionId(id), key),
          settle: (id, key) => sidecar.settleDispatch(SessionId(id), key),
        },
        () => ({ listModels: async () => [{ provider: 'acp-test', id: 'fixture-model', name: 'Fixture' }] }),
        () => ({
          acpSessionId: 'remote-fixture-session',
          initialize: async () => undefined,
          start: async () => undefined,
          prompt,
          close: async () => undefined,
        }),
        sidecar,
      )
      cleanup.push(() => adapter.close())
      const unregister = ctx.llm.registerAdapter(['acp-test'], adapter)
      cleanup.push(unregister)
      const observed: LlmFailure[] = []
      ctx.on('agent/request-error', ({ failure }, next) => {
        observed.push(failure)
        return next()
      })
      const agent = await driver.create(
        SessionId(`failure-${code}`),
        {
          provider: 'acp-test',
          model: 'fixture-model',
        },
        { cwd: root },
      )
      agent.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'bounded fixture' }] }),
      )
      await agent.whenIdle()

      const expected = code === 'ACP_TIMEOUT' ? { message: failure.message, code } : providerFacts
      expect(observed).toEqual([expected])
      expect(Object.isFrozen(observed[0])).toBe(true)
      const events = agent.session.snapshotEvents()
      expect(events.filter((event) => event.type === 'assistant/attempt')).toHaveLength(1)
      expect(events.findLast((event) => event.type === 'turn/end')).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: expected } },
      })
      expect(events.filter((event) => event.type === 'llm/retry')).toEqual([])
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(adapter.providerRetryPolicy('acp-test')).toMatchObject({ maxRetries: 0, retryableCodes: [] })
      expect(await sidecar.readRecoveryState(agent.session.id)).toMatchObject({ kind: 'outcome-unknown' })
    },
  )
})
