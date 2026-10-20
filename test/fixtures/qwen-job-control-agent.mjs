// Real ACP wire and real, test-owned background process. Cancellation refusal
// is deliberate; only the test's file-controlled task completion can stop it.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sessionId = 'qwen-job-control'
const control = process.env.QWEN_JOB_CONTROL
const logPath = process.env.QWEN_JOB_LOG
const mode = process.env.QWEN_JOB_CANCEL_MODE ?? 'reject'
let child
let task
let closing = false
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
}
const send = (value) => {
  if (!closing) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
}
const result = (id, value) => send({ id, result: value })
const update = (text, meta) =>
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(meta ? { _meta: meta } : {}),
      },
    },
  })

function startTask() {
  if (child) return
  if (!control) throw new Error('Missing test-owned control path')
  task = { id: 'controlled-shell', kind: 'shell', label: 'Controlled Qwen task', status: 'running' }
  child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs'); const root=process.argv[1]; let tick=0;
      setInterval(()=>{fs.writeFileSync(root+'.heartbeat.next',String(++tick));
      fs.renameSync(root+'.heartbeat.next',root+'.heartbeat');
      if(fs.existsSync(root+'.finish')) process.exit(0)},25)`,
      control,
    ],
    { stdio: 'ignore' },
  )
  log({ event: 'task-started', pid: child.pid })
  child.once('exit', (code, signal) => {
    task.status = code === 0 ? 'completed' : 'cancelled'
    log({ event: 'task-exited', code, signal, status: task.status })
    if (!closing)
      update('CONTROLLED_TASK_FINISHED', {
        source: 'background_task_completed',
        backgroundTask: { taskId: task.id, kind: task.kind, status: task.status },
      })
  })
}

async function close() {
  if (closing) return
  closing = true
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  process.exit(0)
}
process.once('SIGTERM', () => void close())
process.once('SIGINT', () => void close())
const lines = createInterface({ input: process.stdin })
lines.once('close', () => void close())
lines.on('line', (line) => {
  const request = JSON.parse(line)
  switch (request.method) {
    case 'initialize':
      result(request.id, {
        protocolVersion: 1,
        agentInfo: { name: 'qwen-code', version: '0.25.2', title: 'Qwen job control fixture' },
        agentCapabilities: {},
      })
      break
    case 'session/new':
      result(request.id, {
        sessionId,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'qwen-job-fixture',
            options: [{ value: 'qwen-job-fixture', name: 'Qwen job fixture' }],
          },
        ],
      })
      break
    case 'session/prompt':
      log({ event: 'prompt' })
      startTask()
      update('CONTROLLED_TASK_STARTED')
      result(request.id, { stopReason: 'end_turn' })
      break
    case 'qwen/status/session/tasks':
      result(request.id, { v: 1, sessionId, now: Date.now(), tasks: task ? [task] : [] })
      break
    case 'qwen/control/session/task/cancel':
      log({ event: 'cancel-requested', mode, status: task?.status })
      if (mode === 'reject') send({ id: request.id, error: { code: -32603, message: 'Injected cancellation refusal' } })
      else result(request.id, { cancelled: true, status: 'running' })
      break
    case 'session/cancel':
      break
    default:
      if (request.id !== undefined)
        send({ id: request.id, error: { code: -32601, message: `Unsupported ${request.method}` } })
  }
})
