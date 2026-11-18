import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ACP_CURRENT_CONFIG_MODEL_ID } from '../../../src/contract/model-selection.ts'
import { AcpStubAdapter } from '../../../src/host/composition/llm-stub.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const fixture = fileURLToPath(new URL('../../fixtures/model-config-probe-agent.mjs', import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Event {
  method: string
  sessionId?: string
  phase?: string
  value?: string
  overlap?: boolean
  activeWrites?: number
}

async function probe(runtime: 'codebuddy' | undefined, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acp-codebuddy-model-probe-'))
  roots.push(root)
  const log = join(root, 'wire.jsonl')
  const provider = 'acp-custom-profile'
  const config = {
    name: 'Custom Agent',
    command: process.execPath,
    args: [fixture],
    env: {
      PROBE_LOG: log,
      PROBE_AGENT_NAME: 'codebuddy-code',
      PROBE_MODEL_COUNT: '3',
      PROBE_INITIAL_CONTROLS: '1',
      ...env,
    },
    ...(runtime === undefined ? {} : { runtime }),
  }
  const stub = new AcpStubAdapter({
    agents: () => new Map([[provider, config]]),
    subprocess: { ok: true, seam: (await sharedTestSubprocess()).seam },
    probeOptions: { timeoutMs: 5_000, eofGraceMs: 100, termGraceMs: 300 },
  })
  const models = await stub.listModels(provider)
  return {
    models,
    options: (model: string) => stub.configOptionsForModel(provider, model),
    events: readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Event),
  }
}

function expectSerialCleanup(events: readonly Event[]): void {
  const sessions = events.filter((event) => event.method === 'session/new').map((event) => event.sessionId)
  expect(sessions).toEqual(['probe-session-1'])
  for (const sessionId of sessions) {
    expect(events.filter((event) => event.method === 'session/close' && event.sessionId === sessionId)).toHaveLength(1)
    expect(events.filter((event) => event.method === 'session/delete' && event.sessionId === sessionId)).toHaveLength(1)
  }
  expect(events.some((event) => event.overlap || (event.activeWrites ?? 0) > 1)).toBe(false)
  expect(events.some((event) => event.method === 'session/prompt')).toBe(false)
  expect(events.at(-1)?.method).toBe('process/exit')
}

describe('CodeBuddy model-directory discovery', () => {
  it.each(['codebuddy', undefined] as const)(
    'uses the handshake to discover each model with runtime %s',
    async (runtime) => {
      const result = await probe(runtime)
      expect(result.models.map((model) => model.id)).toEqual(['model-0', 'model-1', 'model-2'])
      for (const model of result.models) {
        expect(result.options(model.id)?.find((option) => option.id === 'thought_level')).toMatchObject({
          currentValue: `effort-${model.id}`,
        })
      }
      expect(result.events.filter((event) => event.phase === 'start').map((event) => event.value)).toEqual([
        'model-1',
        'model-2',
      ])
      expectSerialCleanup(result.events)
    },
  )

  it.each(['codebuddy', undefined] as const)(
    'does not switch a generic peer merely because runtime is %s',
    async (runtime) => {
      const result = await probe(runtime, { PROBE_AGENT_NAME: 'generic-acp' })
      expect(result.models).toHaveLength(3)
      expect(result.events.some((event) => event.method === 'session/set_config_option')).toBe(false)
      expectSerialCleanup(result.events)
    },
  )

  it.each(['absent', 'vendor-choice'])('does not interpret category %s as a model selector', async (category) => {
    const result = await probe('codebuddy', { PROBE_MODEL_CATEGORY: category })
    expect(result.models.map((model) => model.id)).toEqual([ACP_CURRENT_CONFIG_MODEL_ID])
    expect(result.events.some((event) => event.method === 'session/set_config_option')).toBe(false)
    expectSerialCleanup(result.events)
  })

  it('does not borrow default reasoning choices when one model rejects discovery', async () => {
    const result = await probe('codebuddy', { PROBE_REJECT_MODEL: 'model-1' })
    expect(result.models.map((model) => model.id)).toEqual(['model-0', 'model-1', 'model-2'])
    expect(result.options('model-1')).toBeUndefined()
    expect(result.options('model-0')?.find((option) => option.id === 'thought_level')).toMatchObject({
      currentValue: 'effort-model-0',
    })
    expect(result.options('model-2')?.find((option) => option.id === 'thought_level')).toMatchObject({
      currentValue: 'effort-model-2',
    })
    expectSerialCleanup(result.events)
  })
})
