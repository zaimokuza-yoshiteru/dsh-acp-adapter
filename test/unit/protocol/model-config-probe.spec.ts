import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const fixture = fileURLToPath(new URL('../../fixtures/model-config-probe-agent.mjs', import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
type Event = {
  method: string
  sessionId?: string
  phase?: string
  value?: string
  overlap?: boolean
  activeWrites?: number
  rejected?: boolean
}

async function setup(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acp-model-config-probe-'))
  roots.push(root)
  const log = join(root, 'wire.jsonl')
  return {
    spec: {
      argv: [process.execPath, fixture],
      cwd: root,
      env: { PROBE_LOG: log, ...env },
      subprocess: (await sharedTestSubprocess()).seam,
    },
    options: {
      cwd: root,
      timeoutMs: 5_000,
      eofGraceMs: 100,
      termGraceMs: 300,
      probeModelConfigOptions: true,
      probeModelConfigConcurrency: 8,
    },
    events: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Event),
  }
}

function expectCleanup(events: Event[]) {
  const created = [
    ...new Set(
      events.filter((event) => event.method === 'session/new' && !event.rejected).map((event) => event.sessionId),
    ),
  ]
  for (const id of created) {
    expect(events.filter((event) => event.method === 'session/close' && event.sessionId === id)).toHaveLength(1)
    expect(events.filter((event) => event.method === 'session/delete' && event.sessionId === id)).toHaveLength(1)
  }
  expect(events.some((event) => event.overlap)).toBe(false)
  expect(events.some((event) => event.method === 'session/prompt')).toBe(false)
  return created
}

describe('disposable model configuration discovery', () => {
  it('discovers later controls, scans all 123 models, and keeps each worker session serial', async () => {
    const h = await setup()
    const result = await AcpClientConnection.probe(h.spec, h.options)
    expect(Object.keys(result.modelConfigOptions ?? {})).toHaveLength(123)
    for (const index of [1, 33, 122]) {
      expect(
        result.modelConfigOptions?.[`model-${index}`]?.find((option) => option.id === 'thought_level'),
      ).toMatchObject({ currentValue: `effort-model-${index}` })
      expect(result.modelConfigOptions?.[`model-${index}`]?.some((option) => option.id === 'model')).toBe(false)
    }
    expect(result.modelConfigOptions?.['model-0']).toEqual([])
    const events = h.events()
    expect(expectCleanup(events)).toHaveLength(8)
    expect(events.some((event) => (event.activeWrites ?? 0) > 1)).toBe(true)
    expect(
      events.findIndex((event) => event.method === 'session/new' && event.sessionId === 'probe-session-2'),
    ).toBeGreaterThan(events.findIndex((event) => event.phase === 'end' && event.value === 'model-1'))
  })

  it('preserves the old model-variant catalog without creating unused worker sessions', async () => {
    const h = await setup({ PROBE_LEGACY: '1', PROBE_MODEL_COUNT: '266' })
    const result = await AcpClientConnection.probe(h.spec, h.options)
    expect(Object.keys(result.modelConfigOptions ?? {})).toHaveLength(266)
    expect(Object.values(result.modelConfigOptions ?? {}).every((options) => options.length === 0)).toBe(true)
    const model = result.configOptions?.find((option) => option.id === 'model')
    expect(model?.type === 'select' ? model.options : []).toHaveLength(266)
    expect(expectCleanup(h.events())).toHaveLength(1)
  })

  it('keeps rejected model results absent and cleans every successfully created session after partial failures', async () => {
    const h = await setup({
      PROBE_REJECT_MODEL: 'model-9',
      PROBE_REJECT_NEW_AT: '3',
      PROBE_REJECT_DELETE_SESSION: 'probe-session-2',
    })
    const result = await AcpClientConnection.probe(h.spec, h.options)
    expect(result.modelConfigOptions?.['model-9']).toBeUndefined()
    expect(result.modelConfigOptions?.['model-122']?.find((option) => option.id === 'thought_level')).toMatchObject({
      currentValue: 'effort-model-122',
    })
    expect(result.cleanup).toMatchObject({ close: 'done', delete: 'failed' })
    expect(expectCleanup(h.events())).toHaveLength(7)
  })

  it('rejects a mismatched response model and still cleans every worker session', async () => {
    const h = await setup({ PROBE_MISMATCH_MODEL: 'model-7' })
    await expect(AcpClientConnection.probe(h.spec, h.options)).rejects.toMatchObject({
      kind: 'protocol-error',
      message: 'ACP model configuration response did not confirm the requested model',
    })
    expect(expectCleanup(h.events())).toHaveLength(8)
  })

  it('rejects duplicate worker identities before concurrent writes can share a session', async () => {
    const h = await setup({ PROBE_DUPLICATE_NEW_AT: '3' })
    await expect(AcpClientConnection.probe(h.spec, h.options)).rejects.toMatchObject({
      kind: 'protocol-error',
      message: 'ACP probe sessions did not have distinct identities',
    })
    expect(expectCleanup(h.events())).toHaveLength(7)
  })

  it.each([
    ['auth_required', 'PROBE_AUTH_MODEL'],
    ['resource-exhausted', 'PROBE_RESOURCE_MODEL'],
  ])('propagates %s, stops further worker dispatch, and cleans known sessions', async (kind, input) => {
    const h = await setup({ PROBE_INITIAL_CONTROLS: '1', [input!]: 'model-1' })
    await expect(AcpClientConnection.probe(h.spec, h.options)).rejects.toMatchObject({ kind, probePhase: 'session' })
    const events = h.events()
    expect(events.filter((event) => event.phase === 'start').length).toBeLessThanOrEqual(8)
    expect(expectCleanup(events)).toHaveLength(8)
  })

  it('propagates authentication failure while creating optional workers before scanning models', async () => {
    const h = await setup({ PROBE_INITIAL_CONTROLS: '1', PROBE_AUTH_NEW_AT: '3' })
    await expect(AcpClientConnection.probe(h.spec, h.options)).rejects.toMatchObject({
      kind: 'auth_required',
      probePhase: 'session',
    })
    const events = h.events()
    expect(events.some((event) => event.method === 'session/set_config_option')).toBe(false)
    expect(expectCleanup(events)).toHaveLength(7)
  })

  it.each([
    ['timeout', 'PROBE_TIMEOUT_MODEL'],
    ['crash', 'PROBE_CRASH_MODEL'],
  ])('propagates a directory %s without continuing or leaving its process alive', async (kind, input) => {
    const h = await setup({ [input!]: 'model-1' })
    await expect(AcpClientConnection.probe(h.spec, { ...h.options, timeoutMs: 500 })).rejects.toMatchObject({
      kind,
      probePhase: 'session',
    })
    const events = h.events()
    expect(events.filter((event) => event.phase === 'start')).toHaveLength(1)
    expect(events.some((event) => event.method === 'process/exit')).toBe(true)
  })
})
