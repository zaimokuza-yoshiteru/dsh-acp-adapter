import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type * as acp from '@agentclientprotocol/sdk'
import { waitForFileGate } from './file-gate.ts'

/** A deterministic ACP peer: the effective instruction is observable, without a model call. */
const directory = process.env.MOCK_HOST_INSTRUCTIONS_DIRECTORY
if (directory === undefined) throw new Error('MOCK_HOST_INSTRUCTIONS_DIRECTORY is required')
mkdirSync(directory, { recursive: true })
const logPath = join(directory, 'protocol.jsonl')
const lifetime = new AbortController()
type Request = {
  readonly id?: string | number
  readonly method: string
  readonly params?: {
    readonly sessionId?: string
    readonly prompt?: acp.ContentBlock[]
    readonly configId?: string
    readonly value?: string
  }
}
type FixtureSession = {
  readonly id: string
  effective: string
  active?: { readonly caseId: string; readonly phase: string; finish(reason?: 'end_turn' | 'cancelled'): void }
}
const sessions = new Map<string, FixtureSession>()
let ordinal = 0
const record = (event: object) => appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...event })}\n`)
const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const respond = (request: Request, result: object) => {
  if (request.id !== undefined) send({ id: request.id, result })
}
const say = (session: FixtureSession, text: string) =>
  send({
    method: 'session/update',
    params: {
      sessionId: session.id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  })
const snapshot = () => ({
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'fixture-model',
      options: [{ value: 'fixture-model', name: 'Host instruction fixture' }],
    },
  ],
  models: {
    currentModelId: 'fixture-model',
    availableModels: [{ modelId: 'fixture-model', name: 'Host instruction fixture' }],
  },
})
const gate = (caseId: string, phase: string) => join(directory, `${caseId}-${phase}`)
const contentText = (content: readonly acp.ContentBlock[]) =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
const instruction = (content: readonly acp.ContentBlock[]) => {
  const block = content.find(
    (block) => block.type === 'text' && block.text.includes('Current host instructions (replace earlier'),
  )
  return block?.type === 'text' ? /E2E_HOST_INSTRUCTION_([ABC])/.exec(block.text)?.[1] : undefined
}

async function handle(request: Request): Promise<void> {
  if (request.method === 'initialize') {
    respond(request, {
      protocolVersion: 1,
      agentInfo: { name: 'host-instructions-fixture', version: '1.0.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } },
      authMethods: [],
      _meta: { steering: { supported: true, idleBehavior: 'promptRequired' } },
    })
    return
  }
  if (request.method === 'session/new') {
    const session: FixtureSession = { id: `host-instructions-${process.pid}-${++ordinal}`, effective: 'none' }
    sessions.set(session.id, session)
    respond(request, { sessionId: session.id, ...snapshot() })
    return
  }
  if (request.method === 'session/list') {
    respond(request, { sessions: [] })
    return
  }
  const session = sessions.get(request.params?.sessionId ?? '')
  if (session === undefined) {
    if (request.id !== undefined) send({ id: request.id, error: { code: -32602, message: 'Unknown fixture session' } })
    return
  }
  if (request.method === 'session/cancel') {
    session.active?.finish('cancelled')
    return
  }
  if (request.method === 'session/delete' || request.method === 'session/close') {
    session.active?.finish('cancelled')
    sessions.delete(session.id)
    respond(request, {})
    return
  }
  if (request.method === 'session/load' || request.method === 'session/set_model') {
    respond(request, snapshot())
    return
  }
  if (request.method === 'session/set_config_option') {
    if (request.params?.configId !== 'model' || request.params.value !== 'fixture-model') {
      if (request.id !== undefined)
        send({ id: request.id, error: { code: -32602, message: 'Unsupported fixture model configuration' } })
      return
    }
    respond(request, { configOptions: snapshot().configOptions })
    return
  }
  if (request.method !== 'session/prompt' && request.method !== '_session/steering') {
    if (request.id !== undefined)
      send({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } })
    return
  }
  const content = request.params?.prompt ?? []
  const match = /E2E_HOST_CASE ([a-z0-9-]+) ([a-z0-9-]+)/.exec(contentText(content))
  if (match === null) throw new Error('A host-instruction fixture prompt must identify its case and phase')
  const [, caseId, phase] = match as [string, string, string]
  const supplied = instruction(content)
  record({ type: 'received', sessionId: session.id, operation: request.method, caseId, phase, supplied, content })
  if (request.method === '_session/steering' && session.active?.phase === 'hold-refused') {
    record({ type: 'refused', sessionId: session.id, caseId, phase, effective: session.effective })
    // The peer became idle before accepting injection. Let the Host settle its
    // original prompt before acknowledging the atomic promptRequired response.
    say(session, `\nHOST_STATE ${caseId} old-completed ${session.effective}\n`)
    session.active.finish()
    writeFileSync(gate(caseId, 'terminal-sent'), 'ready')
    if (!(await waitForFileGate(gate(caseId, 'release-idle-ack'), lifetime.signal, 'Idle steering ACK gate timed out')))
      return
    respond(request, { outcome: 'promptRequired' })
    record({ type: 'idle-ack', sessionId: session.id, caseId })
    return
  }
  if (request.method === '_session/steering' && session.active === undefined) {
    respond(request, { outcome: 'promptRequired' })
    return
  }
  if (supplied !== undefined) session.effective = supplied
  record({
    type: 'accepted',
    sessionId: session.id,
    operation: request.method,
    caseId,
    phase,
    effective: session.effective,
  })
  if (request.method === '_session/steering') {
    say(session, `\nHOST_STATE ${caseId} ${phase} ${session.effective}\n`)
    respond(request, { outcome: 'injected' })
    session.active?.finish()
    return
  }
  if (!phase.startsWith('hold-')) {
    say(session, `HOST_STATE ${caseId} ${phase} ${session.effective}`)
    respond(request, { stopReason: 'end_turn' })
    return
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, lifetime.signal])
  let completed = false
  session.active = {
    caseId,
    phase,
    finish(reason = 'end_turn') {
      if (completed) return
      completed = true
      session.active = undefined
      respond(request, { stopReason: reason })
      record({ type: 'terminal', sessionId: session.id, caseId, phase, reason })
      controller.abort()
    },
  }
  say(session, `HOST_RUNNING ${caseId} ${session.effective}\n`)
  writeFileSync(gate(caseId, 'active-ready'), 'ready')
  const released = await waitForFileGate(gate(caseId, 'release-active'), signal, 'Active fixture gate timed out')
  if (!completed) session.active?.finish(released ? 'end_turn' : 'cancelled')
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    return
  }
  void handle(request).catch((error: unknown) => {
    record({ type: 'error', message: String(error) })
    if (request.id !== undefined) send({ id: request.id, error: { code: -32603, message: String(error) } })
  })
})
lines.on('close', () => {
  lifetime.abort()
  for (const session of sessions.values()) session.active?.finish('cancelled')
})
