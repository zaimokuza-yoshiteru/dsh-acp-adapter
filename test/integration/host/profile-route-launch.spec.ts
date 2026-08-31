import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const MOCK_AGENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mock-agent', 'mock-agent.mjs')

describe('ACP profile route launch contract', () => {
  it('uses the same native PATH contract as the host health probe', async () => {
    const base = await sharedTestSubprocess()
    const specs: Array<{ argv: readonly string[]; env?: Record<string, string | undefined> }> = []
    const subprocess: SubprocessSeam = {
      spawn: (spec) => {
        specs.push(spec.env === undefined
          ? { argv: [...spec.argv] }
          : { argv: [...spec.argv], env: { ...spec.env } })
        return base.seam.spawn(spec)
      },
      resolveExecutable: (command, env, signal) => base.seam.resolveExecutable(command, env, signal),
    }
    const config: AcpAgentConfig = {
      name: 'Mock ACP',
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `--profile-route-${String(process.pid)}`],
      env: { MOCK_SCENARIO: 'happy', MOCK_LOG: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-profile-route-')), 'agent.log') },
    }
    const adapter = new AcpProfileAdapter(
      'route-test',
      () => config,
      { ok: true, seam: subprocess },
      undefined,
      { begin: async () => undefined, settle: async () => undefined, read: async () => undefined },
    )

    const models = await adapter.listModels('acp-route-test')
    expect(models.length).toBeGreaterThan(0)
    const probe = specs.find(spec => spec.argv[0] === process.execPath)
    expect(probe?.argv).toEqual([process.execPath, MOCK_AGENT_PATH, `--profile-route-${String(process.pid)}`])
    expect(probe?.env?.PATH).toBeUndefined()
    await adapter.close()
  })
})
