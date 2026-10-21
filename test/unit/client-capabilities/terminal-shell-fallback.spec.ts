import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAcpTerminalHandlers } from '../../../src/runtime/client-capabilities/terminal.ts'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

let subprocess: SubprocessSeam
let cwd = ''

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-long-command-'))
})

afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }))

function failure(code: string, syscall = 'spawn') {
  return Object.assign(new Error('fixture launch failed'), { code, syscall })
}

function handle(error?: Error): AcpSubprocessHandle {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    done: error === undefined ? Promise.resolve({ exitCode: 17, signal: null }) : Promise.reject(error),
    terminate() {},
    waitForExit: async () => true,
  }
}

function host(seam: SubprocessSeam) {
  return createAcpTerminalHandlers({
    subprocess: seam,
    profileId: 'devin',
    dshSessionId: 'long-command-test',
    cwd,
    env: {},
    releaseWaitMs: 500,
  })
}

const output = 'long-shell-command-'.repeat(24)
const longCommand = `node -e "process.stdout.write('${output}')"`
const expectedShell = (command: string) =>
  process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command]

describe('ACP terminal shell launch fallback', () => {
  it.skipIf(process.platform === 'win32')(
    'runs a real long shell command once after the executable-name limit',
    async () => {
      const calls: string[][] = []
      const terminals = host({
        ...subprocess,
        spawn: (spec) => {
          calls.push([...spec.argv])
          return subprocess.spawn(spec)
        },
      })
      try {
        const params = { sessionId: 'real-long', command: longCommand }
        const { terminalId } = await terminals.createTerminal(params)
        await expect(terminals.waitForExit({ sessionId: params.sessionId, terminalId })).resolves.toMatchObject({
          exitCode: 0,
        })
        await expect(terminals.terminalOutput({ sessionId: params.sessionId, terminalId })).resolves.toMatchObject({
          output,
          truncated: false,
        })
        expect(calls).toEqual([[longCommand], expectedShell(longCommand)])
        await terminals.releaseTerminal({ sessionId: params.sessionId, terminalId })
      } finally {
        await terminals.dispose()
      }
    },
  )

  it.each(['sync', 'async'] as const)(
    'handles a %s launch-name failure without changing shell quoting or exit status',
    async (delivery) => {
      const calls: string[][] = []
      const error = failure('ENAMETOOLONG')
      const terminals = host({
        ...subprocess,
        spawn: ({ argv }) => {
          calls.push([...argv])
          if (calls.length > 1) return handle()
          if (delivery === 'sync') throw error
          return handle(error)
        },
      })
      try {
        const { terminalId } = await terminals.createTerminal({ sessionId: 'long', command: longCommand })
        await expect(terminals.waitForExit({ sessionId: 'long', terminalId })).resolves.toMatchObject({ exitCode: 17 })
        expect(calls).toEqual([[longCommand], expectedShell(longCommand)])
      } finally {
        await terminals.dispose()
      }
    },
  )

  it.each([
    { name: 'explicit args', command: longCommand, args: ['--version'], syscall: 'spawn' },
    {
      name: 'absolute executable path with spaces',
      command: `/tmp/long executable ${'x'.repeat(300)}`,
      args: [],
      syscall: 'spawn',
    },
    {
      name: 'relative executable path with spaces',
      command: `./long executable ${'x'.repeat(300)}`,
      args: [],
      syscall: 'spawn',
    },
    { name: 'Windows executable path', command: `C:\\long executable ${'x'.repeat(300)}`, args: [], syscall: 'spawn' },
    {
      name: 'UNC executable path',
      command: `\\\\server\\long executable ${'x'.repeat(300)}`,
      args: [],
      syscall: 'spawn',
    },
    {
      name: 'quoted executable prefix',
      command: `"/tmp/long executable" ${'x'.repeat(300)}`,
      args: [],
      syscall: 'spawn',
    },
    { name: 'variable assignment prefix', command: `MODE=test node ${'x'.repeat(300)}`, args: [], syscall: 'spawn' },
    { name: 'bare overlong executable', command: 'x'.repeat(300), args: [], syscall: 'spawn' },
    { name: 'overlong first token', command: `${'x'.repeat(300)} --version`, args: [], syscall: 'spawn' },
    { name: 'short command with another path failure', command: 'node --version', args: [], syscall: 'spawn' },
    { name: 'provider file operation', command: longCommand, args: [], syscall: 'open' },
  ])('preserves ENAMETOOLONG for $name', async ({ command, args, syscall }) => {
    let spawns = 0
    const error = failure('ENAMETOOLONG', syscall)
    const terminals = host({
      ...subprocess,
      spawn: () => {
        spawns++
        throw error
      },
    })
    try {
      await expect(terminals.createTerminal({ sessionId: 'not-shell', command, args })).rejects.toBe(error)
      expect(spawns).toBe(1)
    } finally {
      await terminals.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a real overlong executable path failure without invoking a shell',
    async () => {
      const calls: string[][] = []
      const terminals = host({
        ...subprocess,
        spawn: (spec) => {
          calls.push([...spec.argv])
          return subprocess.spawn(spec)
        },
      })
      const command = path.join(cwd, `long executable ${'x'.repeat(300)}`)
      try {
        const launch = async () => {
          const { terminalId } = await terminals.createTerminal({ sessionId: 'real-path', command })
          return terminals.waitForExit({ sessionId: 'real-path', terminalId })
        }
        await expect(launch()).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
        expect(calls).toEqual([[command]])
      } finally {
        await terminals.dispose()
      }
    },
  )

  it.each(['ENOENT', 'ENAMETOOLONG'])(
    'does not retry a shell that itself fails with %s after a synchronous direct failure',
    async (code) => {
      const calls: string[][] = []
      const error = failure(code, code === 'ENOENT' ? 'spawn fixture' : 'spawn')
      const terminals = host({
        ...subprocess,
        spawn: ({ argv }) => {
          calls.push([...argv])
          if (calls.length === 1) throw error
          return handle(error)
        },
      })
      try {
        const { terminalId } = await terminals.createTerminal({ sessionId: 'shell-failed', command: longCommand })
        await expect(terminals.waitForExit({ sessionId: 'shell-failed', terminalId })).rejects.toBe(error)
        expect(calls).toEqual([[longCommand], expectedShell(longCommand)])
      } finally {
        await terminals.dispose()
      }
    },
  )

  it.each(['cancelled', 'unconfirmed'] as const)(
    'does not fall back after %s cleanup of an asynchronous long-command launch failure',
    async (state) => {
      let spawns = 0
      const error = failure('ENAMETOOLONG')
      const observing = Promise.withResolvers<void>()
      const exited = Promise.withResolvers<boolean>()
      const terminals = host({
        ...subprocess,
        spawn: () => {
          spawns++
          return {
            ...handle(error),
            waitForExit: async () => {
              observing.resolve()
              return exited.promise
            },
          }
        },
      })
      try {
        const { terminalId } = await terminals.createTerminal({ sessionId: 'cancel-long', command: longCommand })
        await observing.promise
        if (state === 'cancelled') await terminals.killTerminal({ sessionId: 'cancel-long', terminalId })
        exited.resolve(state === 'cancelled')
        await expect(terminals.waitForExit({ sessionId: 'cancel-long', terminalId })).rejects.toBe(error)
        expect(spawns).toBe(1)
      } finally {
        exited.resolve(true)
        await terminals.dispose()
      }
    },
  )
})
