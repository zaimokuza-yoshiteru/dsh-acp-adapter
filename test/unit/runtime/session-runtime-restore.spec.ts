import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

it.each(['resume', 'load'] as const)('records an actual %s RPC once, then reuses the live session', async (method) => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-restore-'))
  const source = `
    const readline = require('node:readline');
    let restored = false;
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: 1, agentCapabilities: { loadSession: true, ${method === 'resume' ? 'sessionCapabilities: { resume: {} }' : ''} }
      }});
      else if (request.method === 'session/${method}' && !restored) {
        restored = true;
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'staged' } } } });
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      } else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
    });
  `
  const argv = [process.execPath, '-e', source]
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    config: { command: process.execPath, args: argv.slice(1), env: {} },
    cwd,
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
  })
  try {
    const replay: unknown[] = []
    expect(await runtime.restore({ agentSessionId: 'saved' }, undefined, (value) => replay.push(value))).toBe(
      method === 'resume' ? 'resumed' : 'loaded',
    )
    expect(replay).toHaveLength(1)
    expect(await runtime.restore({ agentSessionId: 'saved' }, undefined, (value) => replay.push(value))).toBe('reused')
    expect(replay).toHaveLength(1)
    await expect(runtime.restore({ agentSessionId: 'other' })).rejects.toThrow('does not match')
  } finally {
    await runtime.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('reuses a live session without restore capability but rejects restoring it after close', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-live-reuse-'))
  const callsFile = join(cwd, 'rpc-methods.log')
  const source = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      fs.appendFileSync(process.env.CALLS_FILE, request.method + '\\n');
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: 1, agentCapabilities: {}
      }});
      else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live' }});
      else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
    });
  `
  const argv = [process.execPath, '-e', source]
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    config: { command: process.execPath, args: argv.slice(1), env: { CALLS_FILE: callsFile } },
    cwd,
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({
      argv,
      env: { CALLS_FILE: callsFile },
      spawnPlan: { argv, env: { CALLS_FILE: callsFile } },
    }),
  })
  try {
    await runtime.start()
    expect(runtime.acpSessionId).toBe('live')
    await expect(runtime.restore({ agentSessionId: 'live' })).resolves.toBe('reused')
    expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual(['initialize', 'session/new'])

    await runtime.close()
    await expect(runtime.restore({ agentSessionId: 'live' })).rejects.toThrow(
      'ACP agent does not advertise session/resume or session/load',
    )
    const methods = readFileSync(callsFile, 'utf8').trim().split('\n')
    expect(methods).toEqual(['initialize', 'session/new', 'initialize'])
    expect(methods).not.toContain('session/resume')
    expect(methods).not.toContain('session/load')
  } finally {
    await runtime.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})
