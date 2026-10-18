import { expect, it, vi } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'

it.each(['launch', 'initialize'])('closes resources if disposal races pending %s', async (phase) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const leaseClose = vi.fn(async () => {})
  const lease: AcpMcpLease = {
    servers: [],
    signal: new AbortController().signal,
    close: leaseClose,
    beginPrompt: () => {},
    endPrompt: () => {},
    permission: () => undefined,
  }
  const initialize = vi.spyOn(AcpClientConnection.prototype, 'initialize').mockImplementation(async () => {
    if (phase === 'initialize') {
      entered.resolve()
      await release.promise
    }
    return { protocolVersion: 1, agentCapabilities: {} }
  })
  const connectionClose = vi.spyOn(AcpClientConnection.prototype, 'close')
  const argv = [process.execPath, '-e', 'process.stdin.resume()']
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    config: { command: argv[0]!, args: argv.slice(1), env: {} },
    cwd: '/tmp',
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => {
      if (phase === 'launch') {
        entered.resolve()
        await release.promise
      }
      return { argv, env: {}, spawnPlan: { argv, env: {} }, mcpLease: lease }
    },
  })
  try {
    const starting = runtime.initialize()
    const rejected = expect(starting).rejects.toThrow()
    await entered.promise
    let closed = false
    const closing = runtime.close().then(() => {
      closed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    release.resolve()
    await rejected
    await closing
    expect(leaseClose).toHaveBeenCalled()
    if (phase === 'launch') expect(initialize).not.toHaveBeenCalled()
    else expect(connectionClose).toHaveBeenCalled()
    expect(runtime.agentCapabilities).toBeUndefined()
  } finally {
    release.resolve()
    await runtime.close()
    initialize.mockRestore()
    connectionClose.mockRestore()
  }
})

const AGENT_SOURCE = `
  const readline = require('node:readline');
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }
    }});
    else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id,
      error: { code: -32603, message: 'session setup refused' }
    });
    else if (request.method === 'session/resume') send({ jsonrpc: '2.0', id: request.id, result: {} });
  });
`

function ownedProcesses(base: SubprocessSeam): {
  readonly seam: SubprocessSeam
  readonly handles: AcpSubprocessHandle[]
} {
  const handles: AcpSubprocessHandle[] = []
  return {
    handles,
    seam: {
      resolveExecutable: (command, env, signal) => base.resolveExecutable(command, env, signal),
      spawn: (spec) => {
        const handle = base.spawn(spec)
        handles.push(handle)
        return handle
      },
    },
  }
}

it('closes the initializing process before waiting for a late MCP lease and blocks restore until setup settles', async () => {
  const tracked = ownedProcesses((await sharedTestSubprocess()).seam)
  const leaseEntered = Promise.withResolvers<void>()
  const releaseLease = Promise.withResolvers<void>()
  const leaseCloseEntered = Promise.withResolvers<void>()
  const releaseLeaseClose = Promise.withResolvers<void>()
  let leaseClosed = false
  let leaseCreations = 0
  const lease: AcpMcpLease = {
    servers: [],
    signal: new AbortController().signal,
    beginPrompt() {},
    endPrompt() {},
    permission() {
      return undefined
    },
    async close() {
      leaseCloseEntered.resolve()
      await releaseLeaseClose.promise
      leaseClosed = true
    },
  }
  const argv = [process.execPath, '-e', AGENT_SOURCE]
  const runtime = new AcpSessionRuntime({
    profileId: 'late-lease-disposal',
    config: { command: process.execPath, args: argv.slice(1), env: {} },
    cwd: process.cwd(),
    subprocess: tracked.seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
    createMcpLease: async () => {
      if (++leaseCreations > 1) return undefined
      leaseEntered.resolve()
      await releaseLease.promise
      return lease
    },
  })
  const starting = runtime.initialize()
  const rejected = expect(starting).rejects.toThrow()
  let closing: Promise<void> | undefined
  let restoring: Promise<'reused' | 'resumed' | 'loaded'> | undefined
  try {
    await leaseEntered.promise
    let closed = false
    closing = runtime.close().then(() => {
      closed = true
    })
    let restored = false
    restoring = runtime.restore({ agentSessionId: 'saved-session' }).then((result) => {
      restored = true
      return result
    })

    // The fixture exits only after protocol stdin EOF. Observe the real
    // provider's exit fact and managed-range quiescence while setup is paused.
    await expect(tracked.handles[0]!.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(tracked.handles[0]!.waitForExit()).resolves.toBe(true)
    expect(closed).toBe(false)
    expect(restored).toBe(false)
    expect(tracked.handles).toHaveLength(1)
    expect(runtime.agentCapabilities).toBeUndefined()

    releaseLease.resolve()
    await leaseCloseEntered.promise
    expect(closed).toBe(false)
    expect(restored).toBe(false)
    expect(leaseClosed).toBe(false)
    expect(tracked.handles).toHaveLength(1)

    releaseLeaseClose.resolve()
    await rejected
    await closing
    expect(leaseClosed).toBe(true)
    await expect(restoring).resolves.toBe('resumed')
    expect(tracked.handles).toHaveLength(2)
    expect(runtime.acpSessionId).toBe('saved-session')
  } finally {
    releaseLease.resolve()
    releaseLeaseClose.resolve()
    await Promise.allSettled([starting, closing, restoring])
    await runtime.close()
  }
})

it('settles a rejected session/new without waiting on its own startup task', async () => {
  const tracked = ownedProcesses((await sharedTestSubprocess()).seam)
  const argv = [process.execPath, '-e', AGENT_SOURCE]
  const runtime = new AcpSessionRuntime({
    profileId: 'failed-session-disposal',
    config: { command: process.execPath, args: argv.slice(1), env: {} },
    cwd: process.cwd(),
    subprocess: tracked.seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
  })
  try {
    await expect(runtime.start()).rejects.toThrow('session setup refused')
    await expect(tracked.handles[0]!.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(tracked.handles[0]!.waitForExit()).resolves.toBe(true)
    expect(runtime.acpSessionId).toBeUndefined()
    expect(runtime.agentCapabilities).toBeUndefined()
    await expect(runtime.restore({ agentSessionId: 'saved-session' })).resolves.toBe('resumed')
    expect(tracked.handles).toHaveLength(2)
  } finally {
    await runtime.close()
  }
})
