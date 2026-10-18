import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { required } from './required.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

// Real Loader -> built ACP plugin -> subprocess wire -> official jobs wake ->
// native AgentLoop and persisted turn/end. Only the external Agent is keyless.
it.each(
  [
    { name: 'unknown terminal reason', endReason: 'failed', partialMarker: undefined, expectedUnknown: true },
    { name: 'explicit successful terminal', endReason: 'end_turn', partialMarker: undefined, expectedUnknown: false },
    { name: 'partial marker and end_turn', endReason: 'end_turn', partialMarker: 'matching', expectedUnknown: true },
    { name: 'nonpartial marker and end_turn', endReason: 'end_turn', partialMarker: 'false', expectedUnknown: false },
    {
      name: 'missing terminal after adoption',
      endReason: 'end_turn',
      partialMarker: undefined,
      expectedUnknown: true,
      dropTerminal: true,
    },
    {
      name: 'missing terminal before delayed adoption',
      endReason: 'end_turn',
      partialMarker: undefined,
      expectedUnknown: true,
      dropTerminal: true,
      adoptionDelayMs: 17_000,
    },
  ].map((entry) => ({ dropTerminal: false, adoptionDelayMs: 0, ...entry })),
)(
  'settles a Qwen automatic turn with $name truthfully in native history',
  async ({ name, endReason, partialMarker, expectedUnknown, dropTerminal, adoptionDelayMs }) => {
    const host = await launchAdapterWorld()
    const directory = join(root, '.local/e2e-qwen-terminal-outcome', randomUUID())
    mkdirSync(directory, { recursive: true })
    const promptLog = join(host.workspaceCwd, 'qwen-prompts.jsonl')
    const prompts = () =>
      existsSync(promptLog) ? readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean) : []
    const facts: Record<string, unknown> = {
      scenario: name,
      endReason,
      partialMarker: partialMarker ?? null,
      dropTerminal,
      adoptionDelayMs,
    }
    try {
      await host.ctx.settings.replace('dsh-acp-adapter', {
        agents: {
          qwen: {
            name: 'Qwen terminal fixture',
            command: process.execPath,
            args: [join(root, 'test/fixtures/fake-qwen-agent.mjs')],
            env: {
              HOME: host.workspaceCwd,
              FAKE_QWEN_HOST_MODEL: '1',
              FAKE_QWEN_END_REASON: endReason,
              FAKE_QWEN_PROMPT_LOG: promptLog,
              ...(partialMarker ? { FAKE_QWEN_PARTIAL_MARKER: partialMarker } : {}),
              ...(dropTerminal ? { FAKE_QWEN_DROP_END: '1' } : {}),
            },
          },
        },
      })
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((entry) => entry.id === 'acp-qwen')).toBe(true))
      await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-qwen', model: 'qwen-fixture' })
      const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd })
      const resolved = await host.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(resolved.error.message)
      const session = resolved.agent.session
      if (adoptionDelayMs > 0)
        host.ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next()
          if (
            decision.kind !== 'reject' &&
            payload.agent.id === sessionId &&
            payload.messages.some((message) => String(message.source.kind) === 'tool-jobs')
          ) {
            // Delay native admission beyond the real negotiated 15s reporting
            // window. The closed transport's failed turn must survive the next
            // initialize/restore and enter this native turn as an attempt.
            facts.delayedNativeWake = true
            await new Promise<void>((resolve) => setTimeout(resolve, adoptionDelayMs))
          }
          return decision
        })
      const observedEvents: SessionEvent[] = []
      facts.observedEvents = observedEvents
      host.ctx.on('session/event', (owner, event) => {
        if (owner.id === sessionId) observedEvents.push(event)
      })
      const endings = () => session.snapshotEvents().filter((event) => event.type === 'turn/end')
      const send = (text: string) =>
        host.ctx.sessionController.prompt(
          {
            requestId: randomUUID() as SessionRequestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
      await send('background')
      await vi.waitFor(() => expect(endings()).toHaveLength(2), { timeout: 30_000 })
      const expectedAutomaticReason = expectedUnknown
        ? { kind: 'error', error: { code: 'ACP_PROTOCOL_ERROR' } }
        : { kind: 'completed' }
      expect(endings()[0]?.data.reason).toMatchObject({ kind: 'completed' })
      expect(endings()[1]?.data.reason).toMatchObject(expectedAutomaticReason)
      if (adoptionDelayMs > 0) expect(facts.delayedNativeWake).toBe(true)
      // Adoption must consume the Agent's existing turn, not replay the task
      // through a second session/prompt even when the terminal reason is bad.
      expect(prompts()).toHaveLength(1)

      let durable: readonly SessionEvent[] = []
      await vi.waitFor(
        async () => {
          const handle = await host.ctx.sessionPersistence.open(sessionId, 'read')
          try {
            durable = (await handle.read()).events
            expect(durable.filter((event) => event.type === 'turn/end')).toHaveLength(2)
          } finally {
            await handle.close()
          }
        },
        { timeout: 20_000 },
      )
      facts.durableEvents = durable
      const persistedEnds = durable.filter((event) => event.type === 'turn/end')
      expect(persistedEnds[1]?.data.reason).toMatchObject(expectedAutomaticReason)
      const automaticAnswers = durable.filter(
        (event) =>
          (event.type === 'assistant/message' || event.type === 'assistant/attempt') &&
          JSON.stringify(event.data).includes('The background command printed done.'),
      )
      expect(
        automaticAnswers,
        'partial output remains in durable native history without a duplicate answer',
      ).toHaveLength(1)
      const automaticAnswer = automaticAnswers[0]
      // Native failures retain the stream as an attempt; they must not acquire
      // a successful assistant message merely to preserve the visible prefix.
      expect(automaticAnswer?.type).toBe(expectedUnknown ? 'assistant/attempt' : 'assistant/message')
      if (automaticAnswer?.type === 'assistant/attempt') {
        expect(JSON.stringify(automaticAnswer.data.stream)).toContain('The background command printed done.')
      }
      expect(
        durable.some((event) => event.type === 'user/message' && String(event.data.source.kind) === 'tool-jobs'),
        'the official jobs completion wakes the native loop',
      ).toBe(true)

      const db = new DatabaseSync(join(required(host.ctx.dshHomePath)('dsh-acp'), 'sidecar.sqlite'), {
        readOnly: true,
      })
      try {
        const recoveryRow = db.prepare('SELECT payload FROM recovery_states WHERE dsh_session_id = ?').get(sessionId)
        const recovery = JSON.parse(String(required(recoveryRow).payload)) as unknown
        expect(recovery).toMatchObject({ kind: expectedUnknown ? 'outcome-unknown' : 'healthy' })
        const dispatch = db
          .prepare('SELECT state FROM dispatch_ledger WHERE dsh_session_id = ? ORDER BY state')
          .all(sessionId)
        expect(dispatch.map((row) => row.state)).toEqual(
          // The ledger retains the current dispatch, pruning older settled rows.
          expectedUnknown ? ['dispatch-uncertain'] : ['settled'],
        )
        Object.assign(facts, { sessionId, persistedEnds, automaticAnswer, recovery, dispatch, prompts: prompts() })
      } finally {
        db.close()
      }
      if (expectedUnknown) {
        await send('continuation-check')
        await vi.waitFor(() => expect(endings()).toHaveLength(3), { timeout: 20_000 })
        expect(endings()[2]?.data.reason).toMatchObject({
          kind: 'error',
          error: { code: 'ACP_RECOVERY_REQUIRED' },
        })
        expect(prompts()).toHaveLength(1)
        facts.blockedContinuation = endings()[2]
      }
      facts.status = 'passed'
    } catch (error) {
      facts.error = String(error)
      facts.prompts = prompts()
      throw error
    } finally {
      try {
        await host.close()
        facts.cleanup = 'closed'
      } finally {
        writeFileSync(join(directory, 'facts.json'), JSON.stringify(facts, null, 2))
      }
    }
  },
  60_000,
)
