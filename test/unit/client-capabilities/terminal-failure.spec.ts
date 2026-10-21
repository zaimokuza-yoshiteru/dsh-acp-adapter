import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AcpTerminalAuditData } from '../../../src/domain/policy/events.ts'
import { createAcpTerminalHandlers } from '../../../src/runtime/client-capabilities/terminal.ts'
import { terminalFailureFacts } from '../../../src/runtime/client-capabilities/terminal-failure.ts'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'

function handle(done: AcpSubprocessHandle['done']): AcpSubprocessHandle {
  return {
    done,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    terminate: () => {},
    waitForExit: async () => true,
  }
}

function fixture(
  spawn: SubprocessSeam['spawn'],
  audit?: (event: AcpTerminalAuditData) => Promise<void>,
  startJob?: Parameters<typeof createAcpTerminalHandlers>[0]['startJob'],
) {
  const events: AcpTerminalAuditData[] = []
  const terminals = createAcpTerminalHandlers({
    subprocess: { spawn, resolveExecutable: async (command) => command },
    dshSessionId: 'diagnostic-owner',
    profileId: 'diagnostic-profile',
    cwd: process.cwd(),
    env: { PRIVATE_ENV: 'environment-secret' },
    startJob,
    audit:
      audit ??
      (async (event) => {
        events.push(event)
      }),
  })
  return { terminals, events }
}

describe('terminal failure evidence', () => {
  it('distinguishes total command bytes from the largest path component and argument shape', () => {
    expect(
      terminalFailureFacts(
        { code: 'ENAMETOOLONG', syscall: 'spawn private-command' },
        'a'.repeat(200) + '/' + '中'.repeat(100),
        ['-e', 'private-argument'],
        'direct',
        'spawn',
      ),
    ).toEqual({
      phase: 'spawn',
      attempt: 'direct',
      code: 'ENAMETOOLONG',
      syscall: 'spawn',
      platform: process.platform,
      commandBytes: 501,
      commandMaxPathComponentBytes: 300,
      argCount: 2,
      argBytes: 18,
      maxArgBytes: 16,
    })
  })

  it('allowlists error fields rather than persisting arbitrary error text', () => {
    const facts = terminalFailureFacts(
      { code: 'secret-code', syscall: 'secret-syscall', message: 'secret-message' },
      'command-secret',
      ['argument-secret'],
      'direct',
      'completion',
    )
    expect(facts).toMatchObject({ code: 'other', syscall: 'other' })
    expect(JSON.stringify(facts)).not.toContain('secret')
    const hostile = {
      get code() {
        throw new Error('secret-getter')
      },
    }
    expect(() => terminalFailureFacts(hostile, 'node', [], 'direct', 'spawn')).not.toThrow()
  })

  it('validates a single read of each error field even when getters change their values', () => {
    let codeReads = 0
    let syscallReads = 0
    const error = {
      get code() {
        return ++codeReads <= 2 ? 'ENOENT' : 'private-value'
      },
      get syscall() {
        return ++syscallReads === 1 ? 'spawn private-executable' : undefined
      },
    }
    const facts = terminalFailureFacts(error, 'node', [], 'direct', 'spawn')
    expect(facts).toMatchObject({ code: 'ENOENT', syscall: 'spawn' })
    expect(codeReads).toBe(1)
    expect(syscallReads).toBe(1)
    expect(JSON.stringify(facts)).not.toContain('private')
  })

  it('does not label job registration rejection as a process launch failure', async () => {
    const error = new Error('fixture owner disposed')
    let attempts = 0
    const { terminals, events } = fixture(
      () => {
        attempts += 1
        return handle(Promise.resolve({ exitCode: 0, signal: null }))
      },
      undefined,
      () => {
        throw error
      },
    )
    try {
      await expect(terminals.createTerminal({ sessionId: 'remote', command: 'node' })).rejects.toBe(error)
      expect(attempts).toBe(0)
      expect(events).toEqual([])
    } finally {
      await terminals.dispose()
    }
  })

  it('records synchronous launch failure without adding a fallback or changing the thrown error', async () => {
    const error = Object.assign(new Error('raw private error'), {
      code: 'ENAMETOOLONG',
      syscall: 'spawn command-secret',
    })
    let attempts = 0
    const { terminals, events } = fixture(() => {
      attempts += 1
      throw error
    })
    try {
      await expect(terminals.createTerminal({ sessionId: 'remote', command: 'command-secret' })).rejects.toBe(error)
      expect(attempts).toBe(1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        operation: 'create',
        outcome: 'error',
        command: '[omitted]',
        failure: { code: 'ENAMETOOLONG', syscall: 'spawn', attempt: 'direct', phase: 'spawn' },
      })
      expect(JSON.stringify(events)).not.toMatch(/command-secret|raw private|environment-secret|PRIVATE_ENV/)
    } finally {
      await terminals.dispose()
    }
  })

  it('records asynchronous provider failure in the exit audit and preserves the original wait failure', async () => {
    const error = Object.assign(new Error('private wait error'), { code: 'E2BIG', syscall: 'spawn private executable' })
    const { terminals, events } = fixture(() => handle(Promise.reject(error)))
    try {
      const { terminalId } = await terminals.createTerminal({
        sessionId: 'remote',
        command: 'node',
        args: ['argument-secret'],
      })
      await expect(terminals.waitForExit({ sessionId: 'remote', terminalId })).rejects.toBe(error)
      await terminals.releaseTerminal({ sessionId: 'remote', terminalId })
      expect(events.find((event) => event.operation === 'exit')).toMatchObject({
        outcome: 'error',
        failure: { code: 'E2BIG', attempt: 'direct', phase: 'completion', argCount: 1 },
      })
      expect(JSON.stringify(events)).not.toMatch(/argument-secret|private wait|private executable|environment-secret/)
    } finally {
      await terminals.dispose()
    }
  })

  it('identifies failure of the existing shell fallback separately from a direct attempt', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT', syscall: 'spawn direct' })
    const denied = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'spawn shell' })
    let attempts = 0
    const { terminals, events } = fixture(() => {
      attempts += 1
      throw attempts === 1 ? missing : denied
    })
    try {
      await expect(terminals.createTerminal({ sessionId: 'remote', command: 'printf OK' })).rejects.toBe(denied)
      expect(attempts).toBe(2)
      expect(events).toHaveLength(1)
      expect(events[0]?.failure).toMatchObject({ code: 'EACCES', attempt: 'shell-fallback', phase: 'spawn' })
    } finally {
      await terminals.dispose()
    }
  })

  it('does not report a recovered ENOENT as a final failure', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT', syscall: 'spawn direct' })
    let attempts = 0
    const { terminals, events } = fixture(() => {
      attempts += 1
      if (attempts === 1) throw missing
      return handle(Promise.resolve({ exitCode: 0, signal: null }))
    })
    try {
      const { terminalId } = await terminals.createTerminal({ sessionId: 'remote', command: 'printf OK' })
      await expect(terminals.waitForExit({ sessionId: 'remote', terminalId })).resolves.toMatchObject({ exitCode: 0 })
      await terminals.releaseTerminal({ sessionId: 'remote', terminalId })
      expect(attempts).toBe(2)
      expect(events.every((event) => event.failure === undefined && event.outcome !== 'error')).toBe(true)
    } finally {
      await terminals.dispose()
    }
  })

  it('keeps the launch error authoritative when evidence storage fails', async () => {
    const error = Object.assign(new Error('original launch failure'), { code: 'EACCES', syscall: 'execve' })
    const { terminals } = fixture(
      () => {
        throw error
      },
      async () => {
        throw new Error('audit unavailable')
      },
    )
    try {
      await expect(terminals.createTerminal({ sessionId: 'remote', command: 'node' })).rejects.toBe(error)
    } finally {
      await terminals.dispose()
    }
  })
})
