import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { acpSettingsSchema } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const MOCK_AGENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mock-agent', 'mock-agent.mjs')

describe('ACP profile route launch contract', () => {
  it('saves and launches an executable path containing spaces and shell punctuation without shell parsing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-command-path-'))
    const directory = path.join(root, 'Agent Tools (local) & test')
    fs.mkdirSync(directory)
    const command = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
    let adapter: AcpProfileAdapter | undefined
    try {
      // A real executable copy also works on Windows without symlink privileges.
      fs.copyFileSync(process.execPath, command, fs.constants.COPYFILE_FICLONE)
      fs.chmodSync(command, 0o700)
      const config = acpSettingsSchema({ agents: { 'path-test': {
        name: 'Path test', command, args: [MOCK_AGENT_PATH],
        env: { MOCK_SCENARIO: 'happy', MOCK_LOG: path.join(root, 'agent.log') },
      } } }).agents['path-test']!
      const subprocess = (await sharedTestSubprocess()).seam
      expect(await subprocess.resolveExecutable(config.command)).toBe(command)
      adapter = new AcpProfileAdapter(
        'path-test', () => config, { ok: true, seam: subprocess }, undefined,
        { begin: async () => undefined, settle: async () => undefined, read: async () => undefined },
      )
      expect((await adapter.listModels('acp-path-test')).length).toBeGreaterThan(0)
    } finally {
      await adapter?.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
