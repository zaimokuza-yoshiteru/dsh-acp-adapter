import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpAgentProcess } from '../../../src/runtime/process/agent-process.ts'
import { DEFAULT_STDERR_MAX_BYTES } from '../../../src/runtime/process/stderr.ts'
import type { AcpSubprocessHandle } from '../../../src/runtime/process/subprocess.ts'

function spawnWithStderr(stderrMaxBytes?: number): { proc: AcpAgentProcess; stderr: PassThrough } {
  const stderr = new PassThrough()
  const child: AcpSubprocessHandle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    done: new Promise(() => {}),
    terminate: () => {},
    waitForExit: async () => true,
  }
  const proc = new AcpAgentProcess(
    {
      argv: ['fixture'],
      cwd: process.cwd(),
      env: {},
      subprocess: { spawn: () => child, resolveExecutable: async (command) => command },
    },
    stderrMaxBytes === undefined ? {} : { stderrMaxBytes },
  )
  return { proc, stderr }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('AcpAgentProcess stderr ingestion', () => {
  it('keeps only the latest carriage-return redraw instead of accumulating progress frames', async () => {
    const { proc, stderr } = spawnWithStderr()
    for (let i = 0; i <= 100; i++) stderr.write(`downloading ${String(i)}%\r`)
    stderr.write('\nfatal: missing credentials\n')
    await tick()

    expect(proc.stderrLines()).toEqual(['downloading 100%', 'fatal: missing credentials'])
  })

  it('treats CR and LF split across chunks as one CRLF line break', async () => {
    const { proc, stderr } = spawnWithStderr()
    stderr.write('first\r')
    await tick()
    stderr.write('\nsecond\n')
    await tick()

    expect(proc.stderrLines()).toEqual(['first', 'second'])
  })

  it('drops a whole oversized line instead of exposing a secret tail and keeps following lines', async () => {
    const { proc, stderr } = spawnWithStderr()
    stderr.write(`password=${'x'.repeat(DEFAULT_STDERR_MAX_BYTES)}`)
    stderr.write('SYNTHETIC_SECRET_TAIL\nordinary follow-up\n')
    await tick()

    expect(proc.stderrLines()).toEqual(['<stderr line truncated>', 'ordinary follow-up'])
    expect(proc.stderrLines().join('\n')).not.toContain('SYNTHETIC_SECRET_TAIL')
  })

  it('drops complete and chunked oversized lines while preserving split PEM protection', async () => {
    const { proc, stderr } = spawnWithStderr(256)
    stderr.write(`prefix ${'x'.repeat(300)} password=${'y'.repeat(300)}\n`)
    stderr.write('-----BEGIN PRIVATE ')
    stderr.write(`KEY-----${'z'.repeat(300)}\nprivate-body-SYNTHETIC\n`)
    stderr.write('-----END PRIVATE ')
    stderr.write('KEY-----\nvisible after key\n')
    await tick()

    const lines = proc.stderrLines()
    const text = lines.join('\n')
    expect(lines.filter((line) => line === '<stderr line truncated>').length).toBeGreaterThanOrEqual(2)
    expect(text).not.toContain('SYNTHETIC')
    expect(lines).toContain('visible after key')
  })

  it('keeps PEM protection across an overlong carriage-return redraw and respects the byte budget', async () => {
    const { proc, stderr } = spawnWithStderr(64)
    stderr.write('-----BEGIN PRIVATE KEY-----\r')
    stderr.write(`${'中'.repeat(40)}\nprivate-body-SYNTHETIC\n`)
    stderr.write('-----END PRIVATE KEY-----\nnormal line\n')
    await tick()

    const lines = proc.stderrLines()
    const text = lines.join('\n')
    expect(text).not.toContain('SYNTHETIC')
    expect(lines).toContain('normal line')
    expect(Buffer.byteLength(text, 'utf8') + lines.length - 1).toBeLessThanOrEqual(64)
  })
  it.each([false, true])('redacts oversized secrets at the default budget (chunked=%s)', async (chunked) => {
    const { proc, stderr } = spawnWithStderr()
    const line = `password=${'x'.repeat(65_536)}SYNTHETIC_SECRET_TAIL`
    if (chunked) {
      stderr.write(line)
      await tick()
      stderr.write('\nnext normal line\n')
    } else {
      stderr.write(`${line}\nnext normal line\n`)
    }
    await tick()
    expect(proc.stderrLines()).toEqual(['<stderr line truncated>', 'next normal line'])
  })
})
