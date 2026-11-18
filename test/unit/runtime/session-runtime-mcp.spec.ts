import type * as acp from '@agentclientprotocol/sdk'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

it.each(['http', 'stdio'] as const)(
  'supplies negotiated %s MCP servers to new and cold-loaded sessions',
  async (transport) => {
    const root = await mkdtemp(join(tmpdir(), 'acp-session-mcp-'))
    const log = join(root, 'requests.jsonl')
    const capabilities = { loadSession: true, mcpCapabilities: { http: transport === 'http' } }
    const script = `
    const fs = require('node:fs');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: 1, agentCapabilities: ${JSON.stringify(capabilities)}
      }});
      else if (request.method === 'session/new' || request.method === 'session/load') {
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n');
        send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'saved-session' } });
      }
    });
  `
    const argv = [process.execPath, '-e', script]
    let generation = 0
    const leaseCloses = [vi.fn(async () => {}), vi.fn(async () => {})]
    const servers = (index: number): acp.McpServer[] =>
      transport === 'http'
        ? [{ type: 'http', name: 'dsh', url: `http://127.0.0.1:1234/lease-${index}`, headers: [] }]
        : [
            {
              name: 'dsh',
              command: process.execPath,
              args: ['session-mcp.js'],
              env: [{ name: 'LEASE', value: String(index) }],
            },
          ]
    const createMcpLease = vi.fn(async (advertised: acp.AgentCapabilities | undefined) => {
      expect(advertised).toEqual(capabilities)
      const index = generation++
      return {
        servers: servers(index),
        signal: new AbortController().signal,
        beginPrompt() {},
        endPrompt() {},
        permission() {
          return undefined
        },
        close: leaseCloses[index]!,
      }
    })
    const runtime = new AcpSessionRuntime({
      profileId: 'devin',
      config: { command: process.execPath, args: argv.slice(1), env: {} },
      subprocess: (await sharedTestSubprocess()).seam,
      cwd: root,
      prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
      createMcpLease,
    })
    try {
      await runtime.start()
      await runtime.close()
      expect(leaseCloses[0]).toHaveBeenCalledOnce()
      await expect(runtime.restore({ agentSessionId: 'saved-session' })).resolves.toBe('loaded')
      const requests = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(requests.map((request) => request.method)).toEqual(['session/new', 'session/load'])
      expect(requests.map((request) => request.params.mcpServers)).toEqual([servers(0), servers(1)])
      expect(createMcpLease).toHaveBeenCalledTimes(2)
      expect(leaseCloses[1]).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    }
    expect(leaseCloses[1]).toHaveBeenCalledOnce()
  },
)
