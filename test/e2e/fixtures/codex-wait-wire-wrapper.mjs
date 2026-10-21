// Transparent test transport. Capture only wait_agent tool updates, never
// session/new MCP connection parameters, credentials, user history or stderr.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [command, ...args] = process.argv.slice(2)
const output = process.env.DSH_WAIT_WIRE_PATH
if (!command || !output) throw new Error('Codex wait capture requires a command and isolated output path')
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
const calls = new Set()
const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method !== 'session/update') return
  const update = message.params?.update
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) return
  const name = update.rawInput?.tool ?? update.rawInput?.name ?? update.title ?? ''
  if (typeof name === 'string' && /(?:^|[._/])wait_agent$/.test(name)) calls.add(update.toolCallId)
  if (!calls.has(update.toolCallId)) return
  appendFileSync(
    output,
    JSON.stringify({ time: new Date().toISOString(), sessionId: message.params.sessionId, update }) + '\n',
  )
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.once('error', (error) => {
  process.stderr.write(`Codex wait fixture spawn failed: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  lines.close()
  process.exitCode = code ?? (signal ? 1 : 0)
  process.stdin.unpipe(child.stdin)
  process.stdin.pause()
})
