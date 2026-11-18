import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { waitForFileGate } from './file-gate.ts'

// Keep the Agent's private history and model across process restarts. Only the
// test controls whether a configuration write is acknowledged, refused or lost.
const directory = process.env.MOCK_SWITCH_DIRECTORY!
const statePath = (id: string) => join(directory, id + '.json')
type State = { model: string; history: string[] }
const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const save = (id: string, state: State) => writeFileSync(statePath(id), JSON.stringify(state))
const options = (model: string) => [
  {
    type: 'select',
    id: 'model',
    category: 'model',
    name: 'Model',
    currentValue: model,
    options: ['a', 'b'].map((value) => ({ name: value.toUpperCase(), value })),
  },
]
const lifetime = new AbortController()
const input = createInterface({ input: process.stdin })
input.on('close', () => lifetime.abort())
input.on('line', async (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id == null || !method) return
  const result = (value: object) => send({ id, result: value })
  const fail = (message: string) => send({ id, error: { code: -32603, message } })
  const fault = readFileSync(join(directory, 'fault'), 'utf8')
  if (method === 'initialize')
    return result({
      protocolVersion: 1,
      agentInfo: { name: fault === 'other-agent' ? 'replacement' : 'switch-fixture', version: '1' },
      agentCapabilities: { loadSession: true },
    })
  const session: string = method === 'session/new' ? randomUUID() : params?.sessionId
  if (typeof session !== 'string' || !/^[a-f0-9-]+$/.test(session)) return fail('Unknown session')
  const log = (data: object) =>
    appendFileSync(join(directory, 'trace'), JSON.stringify({ method, session, pid: process.pid, ...data }) + '\n')
  if (method === 'session/new') {
    save(session, { model: 'a', history: [] })
    log({})
    return result({ sessionId: session, configOptions: options('a') })
  }
  if (!existsSync(statePath(session))) return fail('The original session is unavailable')
  const state: State = JSON.parse(readFileSync(statePath(session), 'utf8'))
  switch (method) {
    case 'session/load':
      log({ model: state.model })
      if (fault === 'unavailable') return fail('The original session could not be loaded')
      if (fault === 'no-snapshot') return result({})
      return result({ configOptions: options(state.model) })
    case 'session/set_config_option': {
      const target = params.value
      log({ target, model: state.model, fault })
      if (fault === 'refuse') return fail('Requested model refused')
      if (fault === 'unconfirmed') return result({ configOptions: options(state.model) })
      if (fault === 'disconnect-before') process.exit(0)
      state.model = target
      save(session, state)
      if (fault === 'disconnect-after') process.exit(0)
      if (fault === 'hold-ack') {
        log({ applied: target })
        if (
          !(await waitForFileGate(join(directory, 'ack'), lifetime.signal, 'Configuration acknowledgement timed out'))
        )
          return
      }
      return result({ configOptions: options(target) })
    }
    case 'session/prompt': {
      const text = (params.prompt as { text?: string }[]).map((block) => block.text ?? '').join('\n')
      const markers = text.match(/SWITCH_TEST_[A-Z]+/g) ?? []
      log({ model: state.model, markers, history: state.history })
      state.history.push(...markers)
      save(session, state)
      send({
        method: 'session/update',
        params: {
          sessionId: session,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Accepted ' + markers.join(',') },
          },
        },
      })
      return result({ stopReason: 'end_turn' })
    }
    default:
      return send({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
