import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  AcpSessionRefreshAbortedError,
  AcpSessionRefreshRetryError,
  AcpSessionRuntime,
} from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { AcpClientError } from '../../../src/protocol/v1/errors.ts'

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

it.each([
  { refresh: true, expectedRestore: 'loaded', expectedProcesses: 2 },
  { refresh: false, expectedRestore: 'reused', expectedProcesses: 1 },
] as const)(
  'refreshes a confirmed-cancelled session only for the opted-in runtime (refresh=$refresh)',
  async ({ refresh, expectedRestore, expectedProcesses }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cancel-refresh-'))
    const callsFile = join(cwd, 'rpc-methods.jsonl')
    const source = `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ pid: process.pid, method: request.method, params: request.params }) + '\\n');
        if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {
          protocolVersion: 1, agentCapabilities: { loadSession: true }
        }});
        else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: {
          sessionId: 'saved',
          modes: { currentModeId: 'review', availableModes: [{ id: 'review', name: 'Review' }] },
          configOptions: [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'minimax-m2.7', options: [{ value: 'minimax-m2.7', name: 'MiniMax M2.7' }] }]
        }});
        else if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' }});
        else if (request.method === 'session/load') send({ jsonrpc: '2.0', id: request.id, result: {
          modes: { currentModeId: 'review', availableModes: [{ id: 'review', name: 'Review' }] },
          configOptions: [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'minimax-m2.7', options: [{ value: 'minimax-m2.7', name: 'MiniMax M2.7' }] }]
        }});
        else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
      });
    `
    const argv = [process.execPath, '-e', source]
    const runtime = new AcpSessionRuntime({
      profileId: 'test',
      ...(refresh ? { refreshSessionAfterCancelledPrompt: true } : {}),
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
      await expect(runtime.prompt([], () => {})).resolves.toMatchObject({ stopReason: 'cancelled' })
      await runtime.retireCancelledSession()
      expect(runtime.acpSessionId).toBe(refresh ? undefined : 'saved')
      if (refresh) {
        // Retiring the process keeps this same logical session's controls
        // available to passive UI reads until its next explicit restore.
        expect(runtime.currentModeId).toBe('review')
        expect(runtime.modes?.availableModes).toEqual([{ id: 'review', name: 'Review' }])
        expect(runtime.configOptions?.find((option) => option.id === 'model')).toMatchObject({
          currentValue: 'minimax-m2.7',
        })
      }
      await expect(runtime.restore({ agentSessionId: 'saved' })).resolves.toBe(expectedRestore)
      expect(runtime.lastRestoreRefreshedCancelledSession).toBe(refresh)
      if (refresh) {
        expect(runtime.acpSessionId).toBe('saved')
        expect(runtime.currentModeId).toBe('review')
        expect(runtime.configOptions?.find((option) => option.id === 'model')).toMatchObject({
          currentValue: 'minimax-m2.7',
        })
      }
      const calls = readFileSync(callsFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { pid: number; method: string; params?: { sessionId?: string } })
      expect(new Set(calls.map((call) => call.pid)).size).toBe(expectedProcesses)
      expect(calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
      expect(calls.filter((call) => call.method === 'session/new')).toHaveLength(1)
      expect(calls.filter((call) => call.method === 'session/load')).toHaveLength(refresh ? 1 : 0)
      if (refresh) expect(calls.find((call) => call.method === 'session/load')?.params?.sessionId).toBe('saved')
    } finally {
      await runtime.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  },
)

it('does not refresh after an unknown prompt outcome', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-cancel-refresh-unknown-'))
  const callsFile = join(cwd, 'rpc-methods.jsonl')
  const source = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      fs.appendFileSync(process.env.CALLS_FILE, request.method + '\\n');
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }});
      else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'saved' }});
      else if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'unknown outcome' }});
      else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
    });
  `
  const argv = [process.execPath, '-e', source]
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    refreshSessionAfterCancelledPrompt: true,
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
    await expect(runtime.prompt([], () => {})).rejects.toThrow()
    await expect(runtime.restore({ agentSessionId: 'saved' })).resolves.toBe('reused')
    expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual(['initialize', 'session/new', 'session/prompt'])
  } finally {
    await runtime.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('retries one transient pre-dispatch setup crash and restores the same cancelled session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-cancel-refresh-retry-'))
  const callsFile = join(cwd, 'rpc-methods.jsonl')
  let launchCount = 0
  const source = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ pid: process.pid, method: request.method, params: request.params }) + '\\n');
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }});
      else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'saved' }});
      else if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' }});
      else if (request.method === 'session/load') send({ jsonrpc: '2.0', id: request.id, result: { modes: { currentModeId: 'review', availableModes: [{ id: 'review', name: 'Review' }] } }});
      else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
    });
  `
  const argv = [process.execPath, '-e', source]
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    refreshSessionAfterCancelledPrompt: true,
    config: { command: process.execPath, args: argv.slice(1), env: { CALLS_FILE: callsFile } },
    cwd,
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => {
      launchCount += 1
      if (launchCount === 2) throw new AcpClientError('crash', 'temporary refresh launch failure')
      const env = { CALLS_FILE: callsFile }
      return { argv, env, spawnPlan: { argv, env } }
    },
  })
  try {
    await runtime.start()
    await expect(runtime.prompt([], () => {})).resolves.toMatchObject({ stopReason: 'cancelled' })
    await expect(runtime.restore({ agentSessionId: 'saved' })).resolves.toBe('loaded')
    expect(runtime.lastRestoreRefreshedCancelledSession).toBe(true)
    expect(launchCount).toBe(3)
    expect(runtime.currentModeId).toBe('review')
    const calls = readFileSync(callsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: { sessionId?: string } })
    expect(calls.filter((call) => call.method === 'session/load')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'session/new')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'session/load').map((call) => call.params?.sessionId)).toEqual([
      'saved',
    ])
  } finally {
    await runtime.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('keeps the cancelled-session refresh pending after bounded launch retries exhaust', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-cancel-refresh-exhaust-'))
  const callsFile = join(cwd, 'rpc-methods.jsonl')
  let launchCount = 0
  const source = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ method: request.method, params: request.params }) + '\\n');
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }});
      else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'saved' }});
      else if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' }});
      else if (request.method === 'session/load') send({ jsonrpc: '2.0', id: request.id, result: { modes: { currentModeId: 'review', availableModes: [{ id: 'review', name: 'Review' }] } }});
      else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
    });
  `
  const argv = [process.execPath, '-e', source]
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    refreshSessionAfterCancelledPrompt: true,
    config: { command: process.execPath, args: argv.slice(1), env: { CALLS_FILE: callsFile } },
    cwd,
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => {
      launchCount += 1
      if (launchCount >= 2 && launchCount <= 4) throw new AcpClientError('crash', 'temporary refresh launch failure')
      const env = { CALLS_FILE: callsFile }
      return { argv, env, spawnPlan: { argv, env } }
    },
  })
  try {
    await runtime.start()
    await expect(runtime.prompt([], () => {})).resolves.toMatchObject({ stopReason: 'cancelled' })
    await expect(runtime.restore({ agentSessionId: 'saved' })).rejects.toBeInstanceOf(AcpSessionRefreshRetryError)
    expect(runtime.cancelledSessionRefreshPending).toBe(true)
    expect(launchCount).toBe(4)

    await expect(runtime.restore({ agentSessionId: 'saved' })).resolves.toBe('loaded')
    expect(runtime.lastRestoreRefreshedCancelledSession).toBe(true)
    expect(runtime.cancelledSessionRefreshPending).toBe(false)
    expect(launchCount).toBe(5)
    const calls = readFileSync(callsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: { sessionId?: string } })
    expect(calls.filter((call) => call.method === 'session/new')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'session/load')).toHaveLength(1)
    expect(calls.find((call) => call.method === 'session/load')?.params?.sessionId).toBe('saved')
  } finally {
    await runtime.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('does not respawn after close cancels a cancelled-session refresh backoff', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-cancel-refresh-close-'))
  const callsFile = join(cwd, 'rpc-methods.txt')
  const secondLaunch = Promise.withResolvers<void>()
  let launchCount = 0
  const source = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      fs.appendFileSync(process.env.CALLS_FILE, request.method + '\\n');
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }});
      else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'saved' }});
      else if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' }});
      else if (request.method === 'session/load') send({ jsonrpc: '2.0', id: request.id, result: {} });
      else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected RPC' } });
    });
  `
  const argv = [process.execPath, '-e', source]
  const runtime = new AcpSessionRuntime({
    profileId: 'test',
    refreshSessionAfterCancelledPrompt: true,
    config: { command: process.execPath, args: argv.slice(1), env: { CALLS_FILE: callsFile } },
    cwd,
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => {
      launchCount += 1
      if (launchCount === 2) {
        secondLaunch.resolve()
        throw new AcpClientError('crash', 'transient refresh failure')
      }
      const env = { CALLS_FILE: callsFile }
      return { argv, env, spawnPlan: { argv, env } }
    },
  })
  try {
    await runtime.start()
    await runtime.prompt([], () => {})
    const restoring = runtime.restore({ agentSessionId: 'saved' })
    await secondLaunch.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    await runtime.close()
    await expect(restoring).rejects.toBeInstanceOf(AcpSessionRefreshAbortedError)
    expect(launchCount).toBe(2)
    expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual(['initialize', 'session/new', 'session/prompt'])
  } finally {
    await runtime.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})
