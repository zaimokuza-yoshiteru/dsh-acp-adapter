import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { acpConfigOptionsSnapshot } from '../../../src/protocol/v1/config-options.ts'
import { createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { teamModeChoices } from '../../../src/contract/session-modes.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

const roots: string[] = []
const sidecars: AcpSidecar[] = []
afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

it('keeps a cold mode ID intact when it shares its 128-character prefix with another valid mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-cold-mode-identity-'))
  roots.push(root)
  const sidecar = createAcpSidecar({ root })
  sidecars.push(sidecar)
  const sessionId = 'cold-mode-identity'
  const prefix = 'm'.repeat(128)
  const target = `${prefix}-target`
  const modes = [
    { value: 'code', name: 'Code' },
    { value: target, name: 'Wanted long mode' },
    { value: prefix, name: 'Different prefix mode' },
  ]
  const messages = [
    createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
    createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }),
  ]
  let events: Array<{ type: string; seq: number; data: unknown }> = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 0 } },
    { type: 'user/message', seq: 2, data: messages[0] },
  ]
  const live = withSessionFacts({
    id: sessionId,
    header: { cwd: os.tmpdir() },
    inheritedEventCount: 0,
    snapshotEvents: () => events,
  })
  const calls: Array<{ setMode?: string; promptMode?: string }> = []
  const profile = (): AcpAgentConfig => ({
    name: 'Cold mode identity fixture',
    command: 'unused-fixture-agent',
    args: [],
    env: {},
    runtime: 'codebuddy',
  })
  const runtimeFactory = (): AcpProfileRuntime => {
    let mode = 'code'
    return {
      acpSessionId: 'cold-mode-agent-session',
      agentInfo: { name: 'cold-mode-fixture', version: '1' },
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      get configOptions() {
        return acpConfigOptionsSnapshot([
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'model-a',
            options: [{ value: 'model-a', name: 'Model A' }],
          },
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: mode,
            options: modes,
          },
        ])
      },
      start: async () => undefined,
      restore: async () => 'resumed',
      setConfigOption: async (id, value) => {
        if (id === 'mode' && typeof value === 'string') {
          mode = value
          calls.push({ setMode: value })
        }
      },
      prompt: async () => {
        const promptMode = modes.find((entry) => entry.value === mode)?.name
        if (promptMode === undefined) throw new Error('Fixture prompt mode is missing')
        calls.push({ promptMode })
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    }
  }
  const seam = { ok: true as const, seam: undefined as never }
  const ledger = {
    begin: (record: Parameters<NonNullable<AcpSidecar['beginDispatch']>>[0]) => sidecar.beginDispatch(record),
    settle: (id: string, key: string) => sidecar.settleDispatch(id as never, key),
    read: (id: string, key: string) => sidecar.readDispatch(id as never, key),
  }
  const makeAdapter = () =>
    new AcpProfileAdapter(
      'review',
      profile,
      seam,
      () => live,
      ledger,
      () => ({
        async listModels() {
          return [{ id: 'model-a', name: 'Model A', provider: 'acp-review' }]
        },
      }),
      runtimeFactory,
      sidecar,
    )
  const request = (message: (typeof messages)[number]) =>
    markAgentLoopRequest({
      provider: 'acp-review',
      model: 'model-a',
      sessionId: sessionId as never,
      messages: [message],
    })
  const drain = async (adapter: AcpProfileAdapter, message: (typeof messages)[number]) => {
    for await (const _chunk of adapter.stream(request(message))) {
      /* consume the production adapter stream */
    }
  }
  const firstAdapter = makeAdapter()
  let nextAdapter: AcpProfileAdapter | undefined
  try {
    await drain(firstAdapter, messages[0]!)
    await firstAdapter.close()
    const cold = await firstAdapter.agentSessionSnapshot(sessionId)
    const choices = teamModeChoices(cold)
    expect(cold).toMatchObject({ freshness: 'stale', modeWritable: true })
    expect(choices.map((choice) => choice.id)).toEqual(['code', target, prefix])
    const selected = choices[1]!
    expect(selected.id).toBe(target)
    const saved = await firstAdapter.setTeamMemberMode(sessionId, selected.id)
    const intent = await sidecar.readModeIntent(sessionId as never)
    expect(saved.pendingModeId).toBe(target)
    expect(intent?.modeId).toBe(target)

    nextAdapter = makeAdapter()
    events = [
      ...events,
      { type: 'step/start', seq: 3, data: { turn: 2, step: 0 } },
      { type: 'user/message', seq: 4, data: messages[1] },
    ]
    await drain(nextAdapter, messages[1]!)
    expect(calls).toContainEqual({ setMode: target })
    expect(calls).toContainEqual({ promptMode: 'Wanted long mode' })
  } finally {
    await firstAdapter.close()
    await nextAdapter?.close()
  }
})
