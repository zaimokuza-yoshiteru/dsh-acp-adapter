import { expect, it } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import type { AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const AGENT_SOURCE = `
  const readline = require('node:readline');
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } }
    }});
    else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'saved-session' }});
    else if (request.method === 'session/resume') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: request.params.sessionId }});
    else if (request.method === 'session/prompt') send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }});
  });
  setInterval(() => {}, 1 << 30);
`

interface TrackedProcess {
  readonly waitForExitEntered: Promise<void>
  releaseExitObservation(): void
}

function delayedExitObservation(base: SubprocessSeam): {
  readonly seam: SubprocessSeam
  readonly processes: TrackedProcess[]
} {
  const processes: TrackedProcess[] = []
  const seam: SubprocessSeam = {
    resolveExecutable: (command, env, signal) => base.resolveExecutable(command, env, signal),
    spawn(spec) {
      const handle = base.spawn(spec)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const waitForExit = handle.waitForExit.bind(handle)
      const record: TrackedProcess = {
        waitForExitEntered: entered.promise,
        releaseExitObservation: () => release.resolve(),
      }
      processes.push(record)
      const wrapped: AcpSubprocessHandle = new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'waitForExit')
            return async (signal?: AbortSignal): Promise<boolean> => {
              entered.resolve()
              await release.promise
              return await waitForExit(signal)
            }
          return Reflect.get(target, property, receiver) as unknown
        },
      })
      return wrapped
    },
  }
  return { seam, processes }
}

function createRuntime(
  subprocess: SubprocessSeam,
  options: { readonly cancelGraceMs: number; readonly mcpLease?: AcpMcpLease },
): AcpSessionRuntime {
  const argv = [process.execPath, '-e', AGENT_SOURCE]
  const env: Record<string, string> = {}
  const prepareLaunch: AcpSessionRuntimeOptions['prepareLaunch'] = async () => ({
    argv,
    env,
    spawnPlan: { argv, env },
    ...(options.mcpLease === undefined ? {} : { mcpLease: options.mcpLease }),
  })
  return new AcpSessionRuntime({
    profileId: 'close-lifecycle-test',
    config: { command: process.execPath, args: argv.slice(1), env },
    cwd: process.cwd(),
    subprocess,
    cancelGraceMs: options.cancelGraceMs,
    prepareLaunch,
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

it('shares close work and waits for the old process before restoring with a short cancel grace', async () => {
  const base = (await sharedTestSubprocess()).seam
  const tracked = delayedExitObservation(base)
  const runtime = createRuntime(tracked.seam, { cancelGraceMs: 15 })
  await runtime.start()
  expect(tracked.processes).toHaveLength(1)

  let firstClosed = false
  let secondClosed = false
  let restoreFinished = false
  const firstClose = runtime.close().then(() => {
    firstClosed = true
  })
  let secondClose: Promise<void> | undefined
  let restore: Promise<'reused' | 'resumed' | 'loaded'> | undefined
  try {
    await tracked.processes[0]!.waitForExitEntered
    secondClose = runtime.close().then(() => {
      secondClosed = true
    })
    restore = runtime.restore({ agentSessionId: 'saved-session' }).then((result) => {
      restoreFinished = true
      return result
    })

    await sleep(60)
    expect(firstClosed).toBe(false)
    expect(secondClosed).toBe(false)
    expect(restoreFinished).toBe(false)
    expect(tracked.processes).toHaveLength(1)

    tracked.processes[0]!.releaseExitObservation()
    await expect(Promise.all([firstClose, secondClose, restore])).resolves.toEqual([undefined, undefined, 'resumed'])
    expect(tracked.processes).toHaveLength(2)
  } finally {
    tracked.processes[0]!.releaseExitObservation()
    await Promise.allSettled([
      firstClose,
      ...(secondClose === undefined ? [] : [secondClose]),
      ...(restore === undefined ? [] : [restore]),
    ])
    for (const record of tracked.processes) record.releaseExitObservation()
    await runtime.close().catch(() => undefined)
  }
})

it('bounds a hanging lease independently while still awaiting connection teardown', async () => {
  const base = (await sharedTestSubprocess()).seam
  const tracked = delayedExitObservation(base)
  const leaseClose = Promise.withResolvers<void>()
  const callsSettled = Promise.withResolvers<void>()
  let leaseCloseFinished = false
  const lease: AcpMcpLease = {
    signal: new AbortController().signal,
    servers: [],
    beginPrompt() {},
    endPrompt() {},
    close: () =>
      leaseClose.promise.then(() => {
        leaseCloseFinished = true
      }),
    hasPendingCalls: () => true,
    hasRetainedFeedback: () => true,
    waitForCallsSettled: () => callsSettled.promise,
    permission: () => undefined,
  }
  const runtime = createRuntime(tracked.seam, { cancelGraceMs: 15, mcpLease: lease })
  await runtime.start()
  let closed = false
  const closing = runtime.close().then(() => {
    closed = true
  })
  try {
    await tracked.processes[0]!.waitForExitEntered
    await sleep(60)
    expect(closed).toBe(false)

    tracked.processes[0]!.releaseExitObservation()
    await closing
    expect(closed).toBe(true)
    expect(runtime.hasRetainedHostFeedback()).toBe(true)
    expect(leaseCloseFinished).toBe(false)
  } finally {
    for (const record of tracked.processes) record.releaseExitObservation()
    await Promise.allSettled([closing])
    leaseClose.resolve()
    callsSettled.resolve()
    await runtime.close().catch(() => undefined)
  }
})
