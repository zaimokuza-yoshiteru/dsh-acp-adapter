import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpAgentProcess } from '../../../src/runtime/process/agent-process.ts'
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

  it('bounds an unterminated line to the configured stderr byte budget', async () => {
    const { proc, stderr } = spawnWithStderr(64)
    for (let i = 0; i < 100; i++) stderr.write('x'.repeat(50))
    stderr.write('TAIL\n')
    await tick()

    const lines = proc.stderrLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.length).toBeLessThan(64)
    expect(lines[0]).toMatch(/TAIL$/)
  })
})
