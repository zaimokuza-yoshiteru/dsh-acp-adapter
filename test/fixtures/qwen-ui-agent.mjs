// Keyless ACP peer for Qwen's native question and per-model reasoning routes.
// Every external effect is confined to the test-owned JSONL log; no tools run.
import { appendFileSync } from 'node:fs'

const SESSION = 'qwen-ui-session'
const MODELS = [
  { value: 'qwen-toggle', name: 'Qwen Toggle' },
  { value: 'qwen-levels', name: 'Qwen Levels' },
  { value: 'qwen-basic', name: 'Qwen Basic' },
]
const EFFORTS = {
  'qwen-toggle': [
    { value: 'none', name: 'Off' },
    { value: 'high', name: 'On' },
  ],
  'qwen-levels': [
    { value: 'none', name: 'None' },
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'xhigh', name: 'Extra high' },
  ],
}
let model = MODELS[0].value
let effort = 'none'
let nextId = 1000
let buffer = ''
let activePrompt
const pending = new Map()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
const error = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32602, message } })
const log = (entry) => {
  if (process.env.QWEN_UI_LOG)
    appendFileSync(process.env.QWEN_UI_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: MODELS },
  ...(EFFORTS[model] === undefined
    ? []
    : [
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: effort,
          options: EFFORTS[model],
        },
      ]),
]
const message = (text) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: SESSION,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  })
const finish = (prompt, stopReason) => {
  if (activePrompt !== prompt) return
  activePrompt = undefined
  result(prompt.id, { stopReason })
}

async function prompt(request) {
  const text = request.params.prompt.map((block) => block.text ?? '').join(' ')
  const marker = text.match(/QWEN_UI_[A-Z_]+/)?.[0] ?? 'QWEN_UI_DEFAULT'
  const turn = { id: request.id, marker }
  activePrompt = turn
  log({
    method: 'session/prompt',
    sessionId: SESSION,
    marker,
    model,
    effort: EFFORTS[model] === undefined ? null : effort,
  })
  if (!['QWEN_UI_SINGLE', 'QWEN_UI_MULTI', 'QWEN_UI_CUSTOM', 'QWEN_UI_DISMISS', 'QWEN_UI_STOP'].includes(marker)) {
    message(`${marker} model=${model} effort=${EFFORTS[model] === undefined ? 'absent' : effort}`)
    finish(turn, 'end_turn')
    return
  }
  const multi = marker === 'QWEN_UI_MULTI'
  const questions = [
    ...(multi
      ? [
          {
            question: 'Which Qwen library?',
            header: 'Library',
            multiSelect: false,
            options: [{ label: 'Qwen A' }, { label: 'Qwen B' }],
          },
        ]
      : []),
    {
      question: multi ? 'Which Qwen features?' : 'Which Qwen library?',
      header: multi ? 'Features' : 'Library',
      multiSelect: multi,
      options: multi
        ? [{ label: 'Qwen X' }, { label: 'Qwen Y' }]
        : [
            { label: 'Qwen A', description: 'First library' },
            { label: 'Qwen B', description: 'Second library' },
          ],
    },
  ]
  const id = nextId++
  const reply = new Promise((resolve) => pending.set(id, resolve))
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: SESSION,
      options: [
        { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: marker,
        title: 'Ask a Qwen question',
        status: 'pending',
        kind: 'think',
        content: [],
        locations: [],
        rawInput: { questions },
        _meta: { toolName: 'ask_user_question', qwenInteractionKind: 'user_question', qwenQuestions: questions },
      },
    },
  })
  const response = await reply
  log({ method: 'question/response', sessionId: SESSION, marker, response: response.result ?? response.error })
  // Stop must reach ACP cancellation, rather than merely decline the question.
  if (activePrompt !== turn || marker === 'QWEN_UI_STOP') return
  message(`${marker} answered`)
  finish(turn, 'end_turn')
}

function receive(request) {
  if (request.method === undefined) {
    const resolve = pending.get(request.id)
    pending.delete(request.id)
    resolve?.(request)
    return
  }
  switch (request.method) {
    case 'initialize':
      log({ method: request.method })
      result(request.id, {
        protocolVersion: 1,
        agentInfo: { name: process.env.QWEN_UI_AGENT_NAME ?? 'qwen-code', title: 'Qwen UI fixture', version: '0.25.1' },
        agentCapabilities: { loadSession: true },
      })
      break
    case 'session/new':
    case 'session/load':
      log({ method: request.method, sessionId: SESSION })
      result(request.id, { sessionId: SESSION, configOptions: configOptions() })
      break
    case 'session/set_config_option': {
      const { configId, value } = request.params
      log({ method: request.method, configId, value, sessionId: SESSION })
      if (configId === 'model' && MODELS.some((entry) => entry.value === value)) {
        model = value
        effort = model === 'qwen-levels' ? 'low' : 'none'
      } else if (configId === 'reasoning_effort' && EFFORTS[model]?.some((entry) => entry.value === value)) {
        effort = value
      } else {
        error(request.id, `Unsupported ${configId}=${String(value)} for ${model}`)
        return
      }
      result(request.id, { configOptions: configOptions() })
      break
    }
    case 'session/prompt':
      void prompt(request)
      break
    case 'session/cancel':
      log({ method: request.method, sessionId: SESSION })
      if (activePrompt !== undefined) finish(activePrompt, 'cancelled')
      break
    case 'qwen/status/session/tasks':
      result(request.id, { v: 1, sessionId: SESSION, now: Date.now(), tasks: [] })
      break
    default:
      if (request.id !== undefined)
        send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) receive(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
