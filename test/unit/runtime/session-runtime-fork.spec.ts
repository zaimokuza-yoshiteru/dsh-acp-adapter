import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AcpForkPreDispatchError, AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fixture(options: { supported?: boolean; remoteError?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-runtime-fork-'))
  const callsFile = path.join(root, 'calls.jsonl')
  const argv = [
    process.execPath,
    '-e',
    `
      const fs = require('node:fs');
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(request.method) + '\\n');
        const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
        if (request.method === 'initialize') reply({
          protocolVersion: 1,
          agentInfo: { name: 'fork-agent', version: '1' },
          agentCapabilities: { sessionCapabilities: ${options.supported === false ? '{}' : '{ fork: {} }'} }
        });
        if (request.method === 'session/fork') {
          ${
            options.remoteError === undefined
              ? "reply({ sessionId: 'agent-child' });"
              : `send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: ${JSON.stringify(options.remoteError)} } });`
          }
        }
      });
    `,
  ]
  const env = { CALLS_FILE: callsFile }
  let runtime: AcpSessionRuntime | undefined
  cleanups.push(async () => {
    try {
      await runtime?.close()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  runtime = new AcpSessionRuntime({
    profileId: 'fork-fixture',
    cwd: root,
    config: { command: argv[0]!, args: argv.slice(1), env },
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
  })
  return {
    runtime,
    calls: () =>
      fs
        .readFileSync(callsFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string),
  }
}

describe('runtime fork dispatch classification', () => {
  it('rejects unsupported forks before intent persistence or RPC dispatch', async () => {
    const world = await fixture({ supported: false })
    let intentCalls = 0
    await expect(
      world.runtime.fork('agent-parent', undefined, undefined, async () => {
        intentCalls += 1
      }),
    ).rejects.toMatchObject({ code: 'ACP_FORK_UNSUPPORTED' })
    expect(intentCalls).toBe(0)
    expect(world.calls()).toEqual(['initialize'])
  })

  it.each([{ protocolVersion: 2 }, { agent: { name: 'other-agent' } }, { agent: { version: '2' } }])(
    'rejects a parent identity mismatch %j before intent persistence',
    async (expected) => {
      const world = await fixture()
      let intentCalls = 0
      await expect(
        world.runtime.fork('agent-parent', undefined, expected, async () => {
          intentCalls += 1
        }),
      ).rejects.toMatchObject({ code: 'ACP_FORK_PRECONDITION_FAILED' })
      expect(intentCalls).toBe(0)
      expect(world.calls()).toEqual(['initialize'])
    },
  )

  it('wraps an intent failure once, preserving its exact cause and dispatch absence', async () => {
    const world = await fixture()
    const cause = new Error('storage refused the intent')
    const error = await world.runtime
      .fork('agent-parent', undefined, undefined, async () => {
        throw cause
      })
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AcpForkPreDispatchError)
    expect(error).toMatchObject({ code: 'ACP_FORK_INTENT_FAILED' })
    expect((error as AcpForkPreDispatchError).cause).toBe(cause)
    expect(world.calls()).toEqual(['initialize'])
    expect(world.runtime.acpSessionId).toBeUndefined()
  })

  it.each(['ACP_FORK_UNSUPPORTED', 'ACP_FORK_PRECONDITION_FAILED', 'ACP_FORK_INTENT_FAILED: remote rejection'])(
    'does not brand a remote error with pre-dispatch-looking text: %s',
    async (remoteError) => {
      const world = await fixture({ remoteError })
      let intentCalls = 0
      const error = await world.runtime
        .fork('agent-parent', undefined, undefined, async () => {
          intentCalls += 1
        })
        .catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(AcpForkPreDispatchError)
      expect(intentCalls).toBe(1)
      expect(world.calls()).toEqual(['initialize', 'session/fork'])
      expect(world.runtime.acpSessionId).toBeUndefined()
    },
  )

  it('preserves a typed parent precondition refusal before RPC dispatch', async () => {
    const world = await fixture()
    const refusal = new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
    await expect(
      world.runtime.fork('agent-parent', undefined, undefined, async () => {
        throw refusal
      }),
    ).rejects.toBe(refusal)
    expect(world.calls()).toEqual(['initialize'])
  })

  it('rechecks synchronous parent state after intent persistence, before RPC dispatch', async () => {
    const world = await fixture()
    let changed = false
    await expect(
      world.runtime.fork(
        'agent-parent',
        undefined,
        undefined,
        async () => {
          changed = true
        },
        () => {
          if (changed) throw new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
        },
      ),
    ).rejects.toMatchObject({ code: 'ACP_FORK_PRECONDITION_FAILED' })
    expect(world.calls()).toEqual(['initialize'])
  })

  it('owns the forked child without first creating an unrelated session', async () => {
    const world = await fixture()
    await expect(world.runtime.fork('agent-parent')).resolves.toMatchObject({ sessionId: 'agent-child' })
    expect(world.runtime.acpSessionId).toBe('agent-child')
    expect(world.calls()).toEqual(['initialize', 'session/fork'])
  })
})
