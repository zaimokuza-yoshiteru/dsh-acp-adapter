import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// A real stdio ACP process whose login state is captured at launch. Changing
// the file affects disposable probes while the existing session stays usable.
const stateFile = process.env.MOCK_PROBE_AUTH_FILE
const logFile = process.env.MOCK_PROBE_LOG_FILE
if (stateFile === undefined || logFile === undefined) throw new Error('Probe fixture paths are required')
const authenticated = readFileSync(stateFile, 'utf8').trim() === 'authenticated'
const log = (event: string, detail: Record<string, unknown> = {}) =>
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, event, authenticated, ...detail })}\n`)
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const configOptions = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'probe-model',
    options: [{ value: 'probe-model', name: 'Probe Model' }],
  },
]
let ordinal = 0
log('started')
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const message = JSON.parse(line) as {
    id?: number | string
    method: string
    params?: { sessionId?: string; prompt?: { type: string; text?: string }[] }
  }
  if (message.id === undefined) return
  const result = (value: unknown) => send({ jsonrpc: '2.0', id: message.id, result: value })
  log(message.method)
  switch (message.method) {
    case 'initialize':
      result({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'probe-refresh-fixture', version: '1.0.0' },
      })
      break
    case 'session/new':
      if (!authenticated) {
        log('auth-required')
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } })
      } else result({ sessionId: `probe-${process.pid}-${++ordinal}`, configOptions })
      break
    case 'session/set_config_option':
      result({ configOptions })
      break
    case 'session/prompt': {
      const marker = message.params?.prompt
        ?.filter((block) => block.type === 'text')
        .map((block) => /E2E_PROBE_[A-Z_]+/.exec(block.text ?? '')?.[0])
        .find((value) => value !== undefined)
      log('prompt-marker', { marker, sessionId: message.params?.sessionId })
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `${marker ?? 'E2E_PROBE_UNKNOWN'}_DONE` },
          },
        },
      })
      result({ stopReason: 'end_turn' })
      break
    }
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
})
input.on('close', () => log('stdin-closed'))
