import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'
import type { QwenTaskJobOutcome, QwenTaskJobStarter } from '../../../src/runtime/session/qwen-background.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const fixture = fileURLToPath(new URL('../../fixtures/fake-qwen-agent.mjs', import.meta.url))
const cleanup: Array<() => Promise<unknown> | void> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const texts = (updates: readonly AcpSessionNotification[]) =>
  updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && update.content.text !== ''
      ? [update.content.text]
      : [],
  )

describe('Qwen mixed input after a confirmed automatic terminal', () => {
  it.each([
    ...(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const).map((reason) => ({
      reason,
      marker: 'absent',
    })),
    { reason: 'end_turn', marker: 'false' },
    { reason: 'cancelled', marker: 'matching' },
  ])(
    'delivers retained input once after $reason with $marker partial marker without replaying the automatic turn',
    async ({ reason, marker }) => {
      const directory = mkdtempSync(join(tmpdir(), 'qwen-followup-terminal-'))
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
      const completion = Promise.withResolvers<QwenTaskJobOutcome>()
      let jobs = 0
      const startJob: QwenTaskJobStarter = (_label, run) => {
        jobs++
        const producer = run()
        void producer.done.then(completion.resolve, completion.reject)
        return { cancel: producer.cancel }
      }
      const env = {
        FAKE_QWEN_END_REASON: reason,
        ...(marker === 'absent' ? {} : { FAKE_QWEN_PARTIAL_MARKER: marker }),
      }
      const argv = [process.execPath, fixture]
      const runtime = new AcpSessionRuntime({
        profileId: 'qwen',
        config: { command: process.execPath, args: [fixture], env },
        cwd: directory,
        subprocess: (await sharedTestSubprocess()).seam,
        prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
        qwenTaskJobs: startJob,
        agentTurnWaitMs: 2_000,
      })
      cleanup.push(() => runtime.close())
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await completion.promise

      const updates: AcpSessionNotification[] = []
      const result = await runtime.prompt(
        [{ type: 'text', text: 'background job acp-qwen-task-1 finished' }],
        (update) => updates.push(update),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'retained input' }] },
      )
      const output = texts(updates)
      expect(output.filter((entry) => entry === 'The background command printed done.')).toHaveLength(1)
      expect(output.filter((entry) => entry.startsWith('echo:'))).toEqual(['echo:retained input'])
      // The retained input is an independent request, not a retry of the
      // automatic turn; its confirmed terminal owns the combined Host call.
      expect(result.stopReason).toBe('end_turn')
      expect(jobs).toBe(1)

      const next: AcpSessionNotification[] = []
      await runtime.prompt([{ type: 'text', text: 'continue afterwards' }], (update) => next.push(update))
      expect(texts(next)).toContain('echo:continue afterwards')
      expect(texts(next)).not.toContain('echo:retained input')
      expect(texts(next)).not.toContain('The background command printed done.')
      expect(jobs).toBe(1)
    },
  )

  it.each(['error', 'failed', 'interrupted', '', 'missing', 'malformed', 'partial=true + end_turn'])(
    'keeps visible automatic output unknown for terminal case %j and never sends retained input',
    async (reason) => {
      const directory = mkdtempSync(join(tmpdir(), 'qwen-followup-unknown-'))
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
      const promptLog = join(directory, 'prompts.jsonl')
      const completion = Promise.withResolvers<QwenTaskJobOutcome>()
      let jobs = 0
      const startJob: QwenTaskJobStarter = (_label, run) => {
        jobs++
        const producer = run()
        void producer.done.then(completion.resolve, completion.reject)
        return { cancel: producer.cancel }
      }
      const env: Record<string, string> = {
        FAKE_QWEN_PROMPT_LOG: promptLog,
        ...(reason === 'partial=true + end_turn'
          ? { FAKE_QWEN_PARTIAL_MARKER: 'matching', FAKE_QWEN_END_REASON: 'end_turn' }
          : reason === 'missing'
            ? { FAKE_QWEN_END_REASON_SHAPE: 'missing' }
            : reason === 'malformed'
              ? { FAKE_QWEN_END_REASON_SHAPE: 'number' }
              : { FAKE_QWEN_END_REASON: reason }),
      }
      const argv = [process.execPath, fixture]
      const runtime = new AcpSessionRuntime({
        profileId: 'qwen',
        config: { command: process.execPath, args: [fixture], env },
        cwd: directory,
        subprocess: (await sharedTestSubprocess()).seam,
        prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
        qwenTaskJobs: startJob,
        agentTurnWaitMs: 2_000,
      })
      cleanup.push(() => runtime.close())
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await completion.promise

      const updates: AcpSessionNotification[] = []
      await expect(
        runtime.prompt(
          [{ type: 'text', text: 'background job acp-qwen-task-1 finished' }],
          (update) => updates.push(update),
          undefined,
          undefined,
          undefined,
          undefined,
          { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'must not dispatch' }] },
        ),
      ).rejects.toMatchObject({
        name: 'AcpAgentTurnOutcomeError',
        code: 'ACP_PROTOCOL_ERROR',
        reason: reason === 'partial=true + end_turn' ? 'incomplete-turn' : 'unrecognized-end-reason',
      })
      expect(texts(updates)).toContain('The background command printed done.')
      // Observe received wire requests, not only absence of a follow-up reply.
      expect(
        readFileSync(promptLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['background'])
      expect(jobs).toBe(1)
    },
  )
})
