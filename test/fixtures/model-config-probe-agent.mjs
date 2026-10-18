// Keyless peer for directory discovery. Every mutation belongs to one disposable session.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const count = Number(process.env.PROBE_MODEL_COUNT ?? 123)
const models = Array.from({ length: count }, (_, index) => ({ value: `model-${index}`, name: `Model ${index}` }))
const sessions = new Map()
let nextSession = 0
let activeWrites = 0
const log = (entry) => appendFileSync(process.env.PROBE_LOG, `${JSON.stringify(entry)}\n`)
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const fail = (id, code = -32602, data = undefined) =>
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'fixture rejection', data } })}\n`,
  )
const configOptions = (session, mismatch = false) => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: mismatch ? 'wrong-model' : session.model,
    options: models,
  },
  ...(process.env.PROBE_LEGACY === '1' || (session.model === 'model-0' && process.env.PROBE_INITIAL_CONTROLS !== '1')
    ? []
    : [
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: `effort-${session.model}`,
          options: [{ value: `effort-${session.model}`, name: `Effort ${session.model}` }],
        },
      ]),
]

async function receive(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    log({ method })
    send(id, {
      protocolVersion: 1,
      agentInfo: { name: 'model-config-fixture', version: '1' },
      agentCapabilities: { sessionCapabilities: { close: {}, delete: {} } },
    })
    return
  }
  if (method === 'session/new') {
    nextSession += 1
    if (
      nextSession === Number(process.env.PROBE_REJECT_NEW_AT) ||
      nextSession === Number(process.env.PROBE_AUTH_NEW_AT)
    ) {
      log({ method, rejected: true })
      fail(id, nextSession === Number(process.env.PROBE_AUTH_NEW_AT) ? -32000 : -32602)
      return
    }
    if (nextSession === Number(process.env.PROBE_DUPLICATE_NEW_AT)) {
      const sessionId = 'probe-session-1'
      log({ method, sessionId })
      send(id, { sessionId, configOptions: configOptions(sessions.get(sessionId)) })
      return
    }
    const sessionId = `probe-session-${nextSession}`
    const session = { model: 'model-0', busy: false }
    sessions.set(sessionId, session)
    log({ method, sessionId })
    send(id, { sessionId, configOptions: configOptions(session) })
    return
  }
  const session = sessions.get(params?.sessionId)
  if (!session) {
    fail(id)
    return
  }
  if (method === 'session/set_config_option') {
    log({
      method,
      phase: 'start',
      sessionId: params.sessionId,
      value: params.value,
      overlap: session.busy,
      activeWrites: ++activeWrites,
    })
    session.busy = true
    if (params.value === process.env.PROBE_TIMEOUT_MODEL) return
    if (params.value === process.env.PROBE_CRASH_MODEL) {
      process.exit(17)
    }
    if (params.value === process.env.PROBE_AUTH_MODEL || params.value === process.env.PROBE_RESOURCE_MODEL) {
      session.busy = false
      activeWrites -= 1
      fail(
        id,
        params.value === process.env.PROBE_AUTH_MODEL ? -32000 : -32011,
        params.value === process.env.PROBE_RESOURCE_MODEL ? { errorKind: 'resource_exhausted' } : undefined,
      )
      return
    }
    await new Promise((resolve) => setImmediate(resolve))
    session.busy = false
    activeWrites -= 1
    log({ method, phase: 'end', sessionId: params.sessionId, value: params.value })
    if (params.value === process.env.PROBE_REJECT_MODEL) {
      fail(id)
      return
    }
    session.model = params.value
    send(id, { configOptions: configOptions(session, params.value === process.env.PROBE_MISMATCH_MODEL) })
    return
  }
  log({ method, sessionId: params.sessionId })
  if (method === 'session/close' || method === 'session/delete') {
    if (method === 'session/delete' && params.sessionId === process.env.PROBE_REJECT_DELETE_SESSION) fail(id)
    else send(id, {})
    return
  }
  fail(id)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  void receive(JSON.parse(line))
})
process.on('exit', () => {
  log({ method: 'process/exit' })
})
