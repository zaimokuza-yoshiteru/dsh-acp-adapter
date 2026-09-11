import { expect, it, vi } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'

it.each(['launch', 'initialize'])('closes resources if disposal races pending %s', async phase => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const leaseClose = vi.fn(async () => {})
  const lease: AcpMcpLease = { servers: [], signal: new AbortController().signal, close: leaseClose, beginPrompt: () => {}, endPrompt: () => {}, permission: () => undefined }
  const initialize = vi.spyOn(AcpClientConnection.prototype, 'initialize').mockImplementation(async () => {
    if (phase === 'initialize') { entered.resolve(); await release.promise }
    return { protocolVersion: 1, agentCapabilities: {} }
  })
  const connectionClose = vi.spyOn(AcpClientConnection.prototype, 'close')
  const argv = [process.execPath, '-e', 'process.stdin.resume()']
  const runtime = new AcpSessionRuntime({
    profileId: 'test', config: { command: argv[0]!, args: argv.slice(1), env: {} }, cwd: '/tmp', subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => {
      if (phase === 'launch') { entered.resolve(); await release.promise }
      return { argv, env: {}, spawnPlan: { argv, env: {} }, mcpLease: lease }
    },
  })
  try {
    const starting = runtime.initialize()
    const rejected = expect(starting).rejects.toThrow()
    await entered.promise
    await runtime.close()
    release.resolve()
    await rejected
    expect(leaseClose).toHaveBeenCalled()
    if (phase === 'launch') expect(initialize).not.toHaveBeenCalled()
    else expect(connectionClose).toHaveBeenCalled()
    expect(runtime.agentCapabilities).toBeUndefined()
  } finally { release.resolve(); await runtime.close(); initialize.mockRestore(); connectionClose.mockRestore() }
})
