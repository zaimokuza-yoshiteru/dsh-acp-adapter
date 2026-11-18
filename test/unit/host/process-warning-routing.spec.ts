import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpStubAdapter } from '../../../src/host/composition/llm-stub.ts'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import type { AcpProbeResult } from '../../../src/protocol/v1/types.ts'

const config = { name: 'Custom Agent', command: 'fixture-agent', args: [], env: {} }
const subprocess = { ok: true as const, seam: undefined as never }
const warning = 'dsh-acp: managed-range exit was not confirmed within the cleanup budget'
const result: AcpProbeResult = {
  sessionId: 'probe-session',
  cleanup: { close: 'not-advertised', delete: 'not-advertised' },
  agentInfo: undefined,
  agentCapabilities: {},
  protocolVersion: 1,
  authMethods: [],
  modes: undefined,
  configOptions: undefined,
  stderrTail: [],
}

afterEach(() => vi.restoreAllMocks())

function probeWarning() {
  return vi.spyOn(AcpClientConnection, 'probe').mockImplementation(async (_spec, options) => {
    options?.onProcessWarn?.(warning)
    return result
  })
}

describe('production process warning routing', () => {
  it.each([false, true])('forwards probe warnings with the provider (prepared cwd: %s)', async (prepared) => {
    probeWarning()
    const warn = vi.fn()
    const adapter = new AcpStubAdapter({
      agents: () => new Map([['acp-custom', config]]),
      subprocess,
      onProcessWarn: warn,
      ...(prepared
        ? {
            prepareProbe: async () => ({
              plan: { argv: ['fixture-agent'], env: {} },
              cwd: '/fixture',
              cleanup: () => undefined,
            }),
          }
        : {}),
    })
    await adapter.listModels('acp-custom')
    expect(warn).toHaveBeenCalledWith('acp-custom', warning)
  })

  it('preserves an explicitly supplied probe observer', async () => {
    probeWarning()
    const host = vi.fn()
    const explicit = vi.fn()
    const adapter = new AcpStubAdapter({
      agents: () => new Map([['acp-custom', config]]),
      subprocess,
      onProcessWarn: host,
      probeOptions: { onProcessWarn: explicit },
    })
    await adapter.listModels('acp-custom')
    expect(explicit).toHaveBeenCalledWith(warning)
    expect(host).not.toHaveBeenCalled()
  })

  it('connects the installed profile default probe to the structured Host logger', async () => {
    probeWarning()
    const log = vi.fn()
    const adapter = new AcpProfileAdapter(
      'custom',
      () => config,
      subprocess,
      undefined,
      { begin: async () => undefined, settle: async () => undefined, read: async () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log,
    )
    try {
      await adapter.listModels('acp-custom')
      expect(log).toHaveBeenCalledWith(warning, {
        acpProvider: 'acp-custom',
        operation: 'probe-process',
        result: 'warning',
      })
    } finally {
      await adapter.close()
    }
  })
})
