import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACP_TERMINAL_MAX_ACTIVE, ACP_TERMINAL_MAX_OUTPUT_BYTES, ACP_TERMINAL_PRESENTATION_MAX_COUNT, createAcpTerminalHandlers } from '../../../src/runtime/client-capabilities/terminal.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import type { AcpSubprocessHandle } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

let subprocess: SubprocessSeam
let root = ''

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-terminal-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function host(audit?: (event: import('../../../src/domain/policy/events.ts').AcpTerminalAuditData) => Promise<void>) {
  return createAcpTerminalHandlers({
    subprocess,
    profileId: 'codex',
    dshSessionId: 'dsh-terminal-test',
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    releaseWaitMs: 500,
    ...(audit === undefined ? {} : { audit }),
  })
}

describe('ACP v1 terminal host', () => {
  it('runs a structured command, merges stdout/stderr, enforces UTF-8 byte truncation and preserves a released presentation snapshot', async () => {
    const events: unknown[] = []
    const terminals = host(async (event) => { events.push(event) })
    const created = await terminals.createTerminal({
      sessionId: 'acp-terminal-1',
      command: process.execPath,
      args: ['-e', "process.stdout.write('a');process.stderr.write('中');process.stdout.write('z')"],
      env: [{ name: 'TERM_SECRET', value: 'do-not-audit' }],
      cwd: root,
      outputByteLimit: 4,
    })
    await expect(terminals.waitForExit({ sessionId: 'acp-terminal-1', terminalId: created.terminalId })).resolves.toMatchObject({ exitCode: 0, signal: null })
    const output = await terminals.terminalOutput({ sessionId: 'acp-terminal-1', terminalId: created.terminalId })
    expect(output.truncated).toBe(true)
    expect(Buffer.byteLength(output.output, 'utf8')).toBeLessThanOrEqual(4)
    expect(output.output).toContain('z')
    await terminals.releaseTerminal({ sessionId: 'acp-terminal-1', terminalId: created.terminalId })
    await expect(terminals.terminalOutput({ sessionId: 'acp-terminal-1', terminalId: created.terminalId })).rejects.toThrow('unknown or already released')
    expect(terminals.presentationSnapshot?.(created.terminalId)).toMatchObject({ terminalId: created.terminalId, released: true, output: output.output, truncated: output.truncated })
    expect(events.map((event) => (event as { operation: string }).operation)).toEqual(['create', 'exit', 'output-summary', 'release'])
    expect(JSON.stringify(events)).not.toContain('TERM_SECRET')
    await terminals.dispose()
  })

  it('rejects cross-session access and keeps a killed terminal ID valid until release', async () => {
    const terminals = host()
    const created = await terminals.createTerminal({
      sessionId: 'owner',
      command: process.execPath,
      args: ['-e', 'setInterval(() => process.stdout.write("tick"), 10)'],
      cwd: root,
      outputByteLimit: 128,
    })
    await expect(terminals.terminalOutput({ sessionId: 'other', terminalId: created.terminalId })).rejects.toThrow('different ACP session')
    await terminals.killTerminal({ sessionId: 'owner', terminalId: created.terminalId })
    const exit = await terminals.waitForExit({ sessionId: 'owner', terminalId: created.terminalId })
    expect(exit.exitCode !== null || exit.signal !== null).toBe(true)
    await expect(terminals.terminalOutput({ sessionId: 'owner', terminalId: created.terminalId })).resolves.toHaveProperty('output')
    await terminals.releaseTerminal({ sessionId: 'owner', terminalId: created.terminalId })
    await terminals.dispose()
  })

  it('release kills a running process and invalidates the protocol ID', async () => {
    const terminals = host()
    const created = await terminals.createTerminal({
      sessionId: 'release-session',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
    })
    await terminals.releaseTerminal({ sessionId: 'release-session', terminalId: created.terminalId })
    expect(terminals.presentationSnapshot?.(created.terminalId)?.released).toBe(true)
    await expect(terminals.killTerminal({ sessionId: 'release-session', terminalId: created.terminalId })).rejects.toThrow('unknown or already released')
    await terminals.dispose()
  })

  it('does not report truncation when the host cap is larger than actual output', async () => {
    const terminals = host()
    const created = await terminals.createTerminal({
      sessionId: 'small-output',
      command: process.execPath,
      args: ['-e', "process.stdout.write('tiny')"],
      cwd: root,
      outputByteLimit: ACP_TERMINAL_MAX_OUTPUT_BYTES + 1,
    })
    await terminals.waitForExit({ sessionId: 'small-output', terminalId: created.terminalId })
    await expect(terminals.terminalOutput({ sessionId: 'small-output', terminalId: created.terminalId })).resolves.toMatchObject({ output: 'tiny', truncated: false })
    await terminals.dispose()
  })

  it('bounds active terminals and released presentation snapshots', async () => {
    const handles: AcpSubprocessHandle[] = []
    const fake: SubprocessSeam = {
      spawn: () => {
        const handle: AcpSubprocessHandle = {
          pid: 7000 + handles.length,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: () => {},
          waitForExit: async () => true,
        }
        handles.push(handle)
        return handle
      },
      resolveExecutable: async (command) => command,
    }
    const terminals = createAcpTerminalHandlers({ subprocess: fake, profileId: 'bounded', dshSessionId: 'dsh-bounded', cwd: root, env: {} })
    const active = []
    for (let i = 0; i < ACP_TERMINAL_MAX_ACTIVE; i += 1) {
      active.push(await terminals.createTerminal({ sessionId: 'bounded-session', command: 'fake' }))
    }
    await expect(terminals.createTerminal({ sessionId: 'bounded-session', command: 'fake' })).rejects.toThrow('active terminal limit')
    await terminals.dispose()

    const snapshots = createAcpTerminalHandlers({ subprocess: fake, profileId: 'snapshots', dshSessionId: 'dsh-snapshots', cwd: root, env: {} })
    const ids: string[] = []
    for (let i = 0; i < ACP_TERMINAL_PRESENTATION_MAX_COUNT + 1; i += 1) {
      const created = await snapshots.createTerminal({ sessionId: 'snapshot-session', command: 'fake' })
      ids.push(created.terminalId)
      await snapshots.releaseTerminal({ sessionId: 'snapshot-session', terminalId: created.terminalId })
    }
    expect(snapshots.presentationSnapshot?.(ids[0]!)).toBeUndefined()
    expect(snapshots.presentationSnapshot?.(ids.at(-1)!)).toMatchObject({ released: true })
    await snapshots.dispose()
    expect(active).toHaveLength(ACP_TERMINAL_MAX_ACTIVE)
  })

  it('disposes many terminals concurrently under one shared deadline', async () => {
    let terminateCount = 0
    const fake: SubprocessSeam = {
      spawn: () => ({
        pid: 8800,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        done: new Promise<never>(() => {}),
        terminate: () => { terminateCount += 1 },
        waitForExit: async () => false,
      }),
      resolveExecutable: async (command) => command,
    }
    const terminals = createAcpTerminalHandlers({ subprocess: fake, profileId: 'dispose', dshSessionId: 'dsh-dispose', cwd: root, env: {}, releaseWaitMs: 20 })
    for (let i = 0; i < 3; i += 1) await terminals.createTerminal({ sessionId: 'dispose-session', command: 'fake' })
    const started = Date.now()
    await terminals.dispose()
    expect(Date.now() - started).toBeLessThan(100)
    expect(terminateCount).toBe(3)
  })

  it('does not claim release when the subprocess seam cannot prove tree exit; the ID remains retryable', async () => {
    let terminateCount = 0
    const neverDone = new Promise<never>(() => {})
    const handle: AcpSubprocessHandle = {
      pid: 9911,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done: neverDone,
      terminate: () => { terminateCount += 1 },
      waitForExit: async () => false,
    }
    const fake: SubprocessSeam = {
      spawn: () => handle,
      resolveExecutable: async (command) => command,
    }
    const terminals = createAcpTerminalHandlers({ subprocess: fake, profileId: 'fake', dshSessionId: 'dsh-fake', cwd: root, env: {}, releaseWaitMs: 1 })
    const created = await terminals.createTerminal({ sessionId: 'stubborn', command: 'fake' })
    await expect(terminals.releaseTerminal({ sessionId: 'stubborn', terminalId: created.terminalId })).rejects.toThrow('retry release')
    expect(terminateCount).toBe(1)
    await expect(terminals.terminalOutput({ sessionId: 'stubborn', terminalId: created.terminalId })).resolves.toHaveProperty('truncated', false)
  })

  it('falls back to the platform shell for a shell command sent as command with no args', async () => {
    const calls: string[][] = []
    const fake: SubprocessSeam = {
      spawn: ({ argv }) => {
        calls.push([...argv])
        const shell = argv[0] === '/bin/sh' || argv[0] === 'cmd.exe'
        if (!shell) {
          const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
          return {
            pid: -1,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            done: Promise.reject(error),
            terminate: () => {},
            waitForExit: async () => true,
          }
        }
        return {
          pid: 7777,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: () => {},
          waitForExit: async () => true,
        }
      },
      resolveExecutable: async (command) => command,
    }
    const terminals = createAcpTerminalHandlers({ subprocess: fake, profileId: 'shell', dshSessionId: 'dsh-shell', cwd: root, env: {} })
    const created = await terminals.createTerminal({ sessionId: 'shell-session', command: 'uname -s' })
    await expect(terminals.waitForExit({ sessionId: 'shell-session', terminalId: created.terminalId })).resolves.toMatchObject({ exitCode: 0 })
    expect(calls).toEqual([['uname -s'], process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'uname -s'] : ['/bin/sh', '-c', 'uname -s']])
    await terminals.dispose()
  })

  it('runs a real shell-style command through the shared subprocess seam', async () => {
    const terminals = host()
    const command = process.platform === 'win32' ? 'ver' : 'uname -s'
    const created = await terminals.createTerminal({ sessionId: 'real-shell-session', command })
    await expect(terminals.waitForExit({ sessionId: 'real-shell-session', terminalId: created.terminalId })).resolves.toMatchObject({ exitCode: 0 })
    await expect(terminals.terminalOutput({ sessionId: 'real-shell-session', terminalId: created.terminalId })).resolves.toMatchObject({ output: expect.any(String) })
    await terminals.dispose()
  })

  it('reports a rejected spawn as error instead of a running terminal', async () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const fake: SubprocessSeam = {
      spawn: () => ({
        pid: -1,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        done: Promise.reject(error),
        terminate: () => {},
        waitForExit: async () => true,
      }),
      resolveExecutable: async (command) => command,
    }
    const terminals = createAcpTerminalHandlers({ subprocess: fake, profileId: 'error', dshSessionId: 'dsh-error', cwd: root, env: {} })
    const created = await terminals.createTerminal({ sessionId: 'error-session', command: 'missing-binary', args: ['--flag'] })
    await expect(terminals.waitForExit({ sessionId: 'error-session', terminalId: created.terminalId })).rejects.toThrow('spawn ENOENT')
    await expect(terminals.terminalOutput({ sessionId: 'error-session', terminalId: created.terminalId })).resolves.toMatchObject({ output: '', exitStatus: null })
    expect(terminals.presentationSnapshot?.(created.terminalId)).toMatchObject({ state: 'error' })
    await terminals.dispose()
  })
})
