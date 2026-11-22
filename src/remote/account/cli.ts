import { tmpdir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { AcpAgentConfig } from '../../contract/agent-config.ts'
import type { SubprocessSeam } from '../../runtime/process/subprocess.ts'
import { stopSubprocess } from '../../runtime/process/cleanup.ts'
import { codexFields, devinPlan, record, type AccountFields } from './fields.ts'

const MAX_OUTPUT_BYTES = 512 * 1024

async function* lines(stream: Readable) {
  stream.setEncoding('utf8')
  let bytes = 0
  let tail = ''
  for await (const chunk of stream) {
    const text = String(chunk)
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_OUTPUT_BYTES) throw new Error('Account query output exceeded limit')
    const parts = (tail + text).split('\n')
    tail = parts.pop() ?? ''
    yield* parts
  }
  if (tail) yield tail
}

async function codexAccount(stdin: Writable, stdout: Readable): Promise<AccountFields> {
  const input = lines(stdout)
  function send(method: string, id?: number, params?: object) {
    stdin.write(JSON.stringify({ method, id, params }) + '\n')
  }
  async function reply(id: number): Promise<unknown> {
    for (;;) {
      const line = await input.next()
      if (line.done) throw new Error('Codex account query closed')
      if (!line.value.trim()) continue
      const message = record(JSON.parse(line.value))
      if (message.id === id) return message.result
    }
  }
  send('initialize', 1, { clientInfo: { name: 'dsh_acp_adapter', version: '1' } })
  if (!(await reply(1))) throw new Error('Codex account query handshake failed')
  send('initialized')
  send('account/read', 2, { refreshToken: false })
  const account = await reply(2)
  if (record(record(account).account).type !== 'chatgpt') return codexFields(account, null)
  send('account/rateLimits/read', 3)
  return codexFields(account, await reply(3))
}

/** Use the configured ACP wrapper's official CLI forwarding command, including its bundled Codex. */
export async function readAccountCli(
  seam: SubprocessSeam,
  profile: AcpAgentConfig,
  provider: 'codex' | 'devin',
  signal: AbortSignal,
): Promise<AccountFields> {
  const args = provider === 'codex' ? ['cli', 'app-server'] : ['auth', 'status', '--process-model', 'in-process']
  const handle = seam.spawn({ argv: [profile.command, ...args], env: profile.env, cwd: tmpdir(), graceMs: 300, signal })
  const done = handle.done.catch(() => null)
  const { stdin, stdout } = handle
  const stopped = Promise.withResolvers<null>()
  const interrupt = () => {
    stopped.resolve(null)
    stdout?.destroy()
  }
  try {
    if (!stdin || !stdout) throw new Error('Account query pipes unavailable')
    // Neither CLI's stderr is an account API; never forward it to diagnostics.
    handle.stderr?.on('error', () => {}).resume()
    stdin.on('error', () => {})
    signal.addEventListener('abort', interrupt, { once: true })
    signal.throwIfAborted()
    if (provider === 'codex') return await codexAccount(stdin, stdout)
    stdin.end()
    let output = ''
    for await (const line of lines(stdout)) output += line + '\n'
    if ((await Promise.race([done, stopped.promise]))?.exitCode !== 0) throw new Error('Devin account unavailable')
    return devinPlan(output)
  } finally {
    signal.removeEventListener('abort', interrupt)
    await stopSubprocess(handle, { eofGraceMs: 100, exitWaitMs: 1200 })
  }
}
