// Minimal Qwen Code ACP stand-in (wire shapes from qwen-code 0.25 acp-integration).
// Prompt text selects the scenario:
//   "ask"        -> ask_user_question via session/request_permission, echoes `answers`
//   "background" -> finishes the prompt, then completes task bg-1 out of turn,
//                   announces `_qwencode/start_turn`, streams a reply, `_qwencode/end_turn`
//   "background-ask" -> as background, but the Qwen-initiated turn asks a question first
//   anything else -> plain reply
// FAKE_QWEN_START_TIMEOUT_MS bounds the wait for the start_turn answer (Qwen: 2 s).
import { appendFileSync } from 'node:fs'

let buffer = ''
let nextId = 1000
const pending = new Map()
const SESSION = 'qwen-session'
const tasks = [{ kind: 'shell', id: 'bg-1', label: 'sleep 1 && echo done', status: 'running', startTime: 1 }]
const cancelled = []
let backgroundTurn
let activeWorkSeq = 0
let activeWorkEnabled = false
let cronActive = false
let cronCancelled = false
const activeWork = () => {
  if (!activeWorkEnabled) return
  send({
    jsonrpc: '2.0',
    method: 'qwen/notify/channel/active-work',
    params: {
      v: 1,
      seq: ++activeWorkSeq,
      sessions: [
        {
          sessionId: SESSION,
          holds:
            cronActive && process.env.FAKE_QWEN_IDLE_ONLY !== '1'
              ? [{ category: 'session', id: 'session:active-turn' }]
              : [],
        },
      ],
    },
  })
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
const update = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update } })
const text = (value, meta) =>
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: value },
    ...(meta === undefined ? {} : { _meta: meta }),
  })

// Qwen emits this empty response segment when a background response was only
// partially produced. Keep it separate from visible text and explicit endings.
const partialMarker = (turnId) => {
  const mode = process.env.FAKE_QWEN_PARTIAL_MARKER
  if (mode === undefined) return
  const backgroundTask = { taskId: 'bg-1', turnId, turnComplete: true, partial: true }
  if (mode === 'false') backgroundTask.partial = false
  if (mode === 'wrong-turn') backgroundTask.turnId = 'other-turn'
  if (mode === 'nonboolean-partial') backgroundTask.partial = 'true'
  if (mode === 'nonboolean-complete') backgroundTask.turnComplete = 'true'
  if (mode === 'missing-turn') delete backgroundTask.turnId
  if (mode === 'missing-complete') delete backgroundTask.turnComplete
  if (mode === 'missing-partial') delete backgroundTask.partial
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: mode === 'wrong-session' ? 'other-session' : SESSION,
      update: {
        sessionUpdate: mode === 'non-message' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          source: mode === 'wrong-source' ? 'other-source' : 'background_notification_response',
          qwenDiscreteMessage: true,
          backgroundTask: mode === 'array-task' ? [] : mode === 'null-task' ? null : backgroundTask,
        },
      },
    },
  })
}

const QUESTIONS = [
  {
    question: 'Which library?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ],
  },
  { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
]

async function ask(meta) {
  const response = await request('session/request_permission', {
    sessionId: SESSION,
    options: [
      { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    toolCall: {
      toolCallId: 'question-1',
      status: 'pending',
      title: 'Ask user 2 questions',
      content: [],
      locations: [],
      kind: 'think',
      rawInput: { questions: QUESTIONS, metadata: { source: 'test' } },
      _meta: { toolName: 'ask_user_question', qwenInteractionKind: 'user_question', qwenQuestions: QUESTIONS },
    },
    ...(meta === undefined ? {} : { _meta: meta }),
  })
  return response
}

async function runBackground(withQuestion) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  tasks[0].status = 'completed'
  text('Background shell bg-1 completed: done', {
    source: 'background_task_completed',
    qwenDiscreteMessage: true,
    backgroundTask: { taskId: 'bg-1', status: 'completed', kind: 'shell', sourceTurnId: 't0' },
  })
  const turnId = `${SESSION}########notification1`
  const timeoutMs = Number(process.env.FAKE_QWEN_START_TIMEOUT_MS ?? 2000)
  const answer = await Promise.race([
    request('_qwencode/start_turn', {
      sessionId: SESSION,
      source: 'background_notification',
      turnId,
      taskId: 'bg-1',
      kind: 'shell',
      label: 'sleep 1 && echo done',
      startedAt: Date.now(),
    }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
  ])
  const proceed = answer?.result?.accepted === true || answer?.error?.code === -32601
  text(`start_turn:${JSON.stringify(answer?.result ?? answer?.error?.code ?? answer)}`, { source: 'fake-diagnostic' })
  if (!proceed) return
  const meta = { backgroundTurn: { turnId, taskId: 'bg-1', kind: 'shell' } }
  backgroundTurn = { turnId, ended: false }
  if (process.env.FAKE_QWEN_IGNORE_CANCEL === '1') {
    text('background still running', meta)
    setTimeout(() => text('late background output', meta), 200)
    return
  }
  if (withQuestion) {
    const response = await ask(meta)
    text(`bg-answers:${JSON.stringify(response?.result?.answers ?? null)}`, meta)
  }
  if (process.env.FAKE_QWEN_BACKGROUND_FS === '1') {
    void request('fs/write_text_file', { sessionId: SESSION, path: '/fixture/output.txt', content: 'result' })
  }
  if (process.env.FAKE_QWEN_WRONG_END !== undefined) {
    send({
      jsonrpc: '2.0',
      method: '_qwencode/end_turn',
      params: {
        sessionId: process.env.FAKE_QWEN_WRONG_END === 'session' ? 'other-session' : SESSION,
        turnId: process.env.FAKE_QWEN_WRONG_END === 'turn' ? 'other-turn' : turnId,
        reason: 'end_turn',
      },
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  if (backgroundTurn.ended) return
  text('The background command printed done.', { ...meta, source: 'background_notification_response' })
  if (process.env.FAKE_QWEN_PARTIAL_MARKER_ORDER !== 'after-end') partialMarker(turnId)
  backgroundTurn.ended = true
  const terminal = {
    jsonrpc: '2.0',
    method: '_qwencode/end_turn',
    params: {
      sessionId: SESSION,
      ...(process.env.FAKE_QWEN_END_REASON_SHAPE === 'missing'
        ? {}
        : {
            reason:
              process.env.FAKE_QWEN_END_REASON_SHAPE === 'number'
                ? 7
                : (process.env.FAKE_QWEN_END_REASON ?? 'end_turn'),
          }),
      turnId,
      source: 'background_notification',
    },
  }
  send(terminal)
  if (process.env.FAKE_QWEN_PARTIAL_MARKER_ORDER === 'after-end') {
    partialMarker(turnId)
    send(terminal)
  }
}

// Qwen cron/loop turn: no start/end markers, only the echoed prompt and
// usage chunks closing each model round.
async function runCron(respond, slowHook = false) {
  if (respond === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
  cronActive = true
  cronCancelled = false
  activeWork()
  const usage = () =>
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, durationMs: 1 },
    })
  update({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'check the build' },
    _meta: { source: 'cron' },
  })
  text('cron working')
  usage()
  if (process.env.FAKE_QWEN_TRANSIENT_IDLE === '1') {
    cronActive = false
    activeWork()
    await new Promise((resolve) => setTimeout(resolve, 50))
    cronActive = true
    activeWork()
  }
  if (process.env.FAKE_QWEN_STALE_WORK === '1') {
    send({
      jsonrpc: '2.0',
      method: 'qwen/notify/channel/active-work',
      params: {
        v: 1,
        seq: activeWorkSeq,
        sessions: [{ sessionId: SESSION, holds: [] }],
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'qwen/notify/channel/active-work',
      params: {
        v: 1,
        seq: activeWorkSeq + 1000,
        sessions: [{ sessionId: SESSION, holds: 'malformed' }],
      },
    })
  }
  if (process.env.FAKE_QWEN_FAST_CRON === '1') {
    text('cron done')
    cronActive = false
    activeWork()
    return
  }
  if (slowHook) {
    // Real Qwen emits usage before runToolCalls, whose PreToolUse hook and
    // permission happen before emitStart. No wire update is owed by the hook.
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (cronCancelled) return
    const permission = await request('session/request_permission', {
      sessionId: SESSION,
      toolCall: { toolCallId: 'cron-tool', title: 'Run build', kind: 'execute', status: 'pending' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
    })
    text(`cron-permission:${permission?.result?.outcome?.outcome ?? 'missing'}`)
  }
  // "schedule-inline": Qwen drains cron before answering the prompt.
  respond?.()
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'cron-tool',
    title: 'Run build',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'npm run build' },
  })
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-tool', status: 'in_progress' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (cronCancelled) return
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-tool', status: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (cronCancelled) return
  text('cron done')
  usage()
  cronActive = false
  activeWork()
}

async function onPrompt(message) {
  const prompt = message.params.prompt.map((block) => block.text ?? '').join(' ')
  if (process.env.FAKE_QWEN_PROMPT_LOG !== undefined)
    appendFileSync(process.env.FAKE_QWEN_PROMPT_LOG, `${JSON.stringify(prompt)}\n`)
  if (prompt.includes('ask') && !prompt.includes('background')) {
    const response = await ask()
    text(
      `answers:${JSON.stringify(response?.result?.answers ?? null)} outcome:${JSON.stringify(response?.result?.outcome ?? null)}`,
    )
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  text(`echo:${prompt}`)
  if (prompt.includes('ordinary-metadata'))
    text('ordinary background-shaped answer', {
      source: 'background_task_completed',
      backgroundTask: { taskId: 'ordinary', status: 'completed' },
    })
  if (prompt.includes('schedule-inline')) {
    void runCron(() => send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }))
    return
  }
  send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  // Qwen's per-request lifecycle marker can trail the prompt response.
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '' },
    _meta: {
      executionLifecycle: {
        v: 1,
        kind: 'request',
        executionId: 'e1',
        sessionId: SESSION,
        promptId: 'p1',
        model: 'm',
        startedAt: 1,
        phase: 'ended',
        endedAt: 2,
        durationMs: 1,
        outcome: 'success',
      },
    },
  })
  if (prompt.includes('background') && tasks[0].status === 'running')
    void runBackground(prompt.includes('background-ask'))
  if (prompt.includes('schedule')) void runCron(undefined, prompt.includes('slow-hook'))
}

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.method === undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
      continue
    }
    switch (message.method) {
      case 'initialize':
        activeWorkEnabled =
          process.env.FAKE_QWEN_NO_ACTIVE_WORK !== '1' &&
          message.params._meta?.['qwen.daemon.activeWorkHeartbeat']?.v === 1
        if (activeWorkEnabled && process.env.FAKE_QWEN_IDLE_ONLY === '1') setInterval(activeWork, 20).unref()
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: process.env.FAKE_QWEN_AGENT_NAME ?? 'qwen-code', title: 'Qwen Code', version: '0.25.1' },
            agentCapabilities: { loadSession: true },
            ...(activeWorkEnabled
              ? { _meta: { 'qwen.daemon.activeWorkHeartbeat': { v: 1, intervalMs: 5000, categories: ['session'] } } }
              : {}),
          },
        })
        break
      case 'session/new':
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            sessionId: SESSION,
            ...(process.env.FAKE_QWEN_HOST_MODEL === '1'
              ? {
                  configOptions: [
                    {
                      id: 'model',
                      name: 'Model',
                      category: 'model',
                      type: 'select',
                      currentValue: 'qwen-fixture',
                      options: [{ value: 'qwen-fixture', name: 'Qwen fixture' }],
                    },
                  ],
                }
              : {}),
          },
        })
        break
      case 'session/prompt':
        void onPrompt(message)
        break
      case 'session/cancel':
        if (process.env.FAKE_QWEN_IGNORE_CANCEL === '1') break
        if (cronActive) {
          cronCancelled = true
          cronActive = false
          activeWork()
        }
        if (backgroundTurn !== undefined && !backgroundTurn.ended) {
          backgroundTurn.ended = true
          send({
            jsonrpc: '2.0',
            method: '_qwencode/end_turn',
            params: {
              sessionId: SESSION,
              reason: 'cancelled',
              turnId: backgroundTurn.turnId,
              source: 'background_notification',
            },
          })
        }
        break
      case 'qwen/status/session/tasks':
        send({ jsonrpc: '2.0', id: message.id, result: { v: 1, sessionId: SESSION, now: Date.now(), tasks } })
        break
      case 'qwen/control/session/task/cancel':
        cancelled.push(message.params)
        tasks[0].status = 'cancelled'
        send({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
        text('Background shell bg-1 cancelled', {
          source: 'background_task_completed',
          backgroundTask: { taskId: message.params.taskId, status: 'cancelled', kind: message.params.taskKind },
        })
        break
      default:
        if (message.id !== undefined)
          send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1 << 30)
