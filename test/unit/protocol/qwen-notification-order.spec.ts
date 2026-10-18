import * as acp from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import { AcpClientError } from '../../../src/protocol/v1/errors.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'

it('rejects a Qwen connection before spawning if SDK notification registration no longer exposes ordered handlers', () => {
  const registration = vi.spyOn(acp.ClientApp.prototype, 'onNotification').mockImplementation(function (
    this: acp.ClientApp,
  ) {
    return this
  })
  const spawn = vi.fn<SubprocessSeam['spawn']>(() => {
    throw new Error('An unsupported SDK must fail before acquiring a process')
  })
  try {
    let failure: unknown
    try {
      new AcpClientConnection(
        {
          argv: ['qwen', '--acp'],
          cwd: process.cwd(),
          env: {},
          subprocess: { spawn, resolveExecutable: async (command) => command },
        },
        { onQwenTurnEnd: () => {} },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AcpClientError)
    expect(failure).toMatchObject({ kind: 'protocol-error', code: 'ACP_PROTOCOL_ERROR' })
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    registration.mockRestore()
  }
})
