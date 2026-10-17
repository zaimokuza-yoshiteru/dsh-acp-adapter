import { afterEach, describe, expect, it } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'
import type { AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const runtimes: AcpSessionRuntime[] = []
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()))
})

async function fixture(
  image: boolean | undefined,
  options: { lease?: AcpMcpLease; mcpKey?: () => unknown; subprocess?: SubprocessSeam; waitForCancel?: boolean } = {},
) {
  const script = `
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    let promptId;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      const reply = result => send({jsonrpc:'2.0',id:request.id,result});
      if(request.method==='initialize') reply({protocolVersion:1,agentCapabilities:${JSON.stringify(image === undefined ? {} : { promptCapabilities: { image } })}});
      if(request.method==='session/new') reply({sessionId:'image-fixture'});
      if(request.method==='session/prompt') {
        if(!${options.waitForCancel === true}) process.exit(0);
        else {
          promptId=request.id;
          send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'image-fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting for cancel'}}}});
        }
      }
      if(request.method==='session/cancel' && promptId !== undefined) send({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}});
    });`
  const argv = [process.execPath, '-e', script]
  const runtime = new AcpSessionRuntime({
    profileId: 'image-fixture',
    cwd: process.cwd(),
    config: { command: argv[0]!, args: argv.slice(1), env: {} },
    subprocess: options.subprocess ?? (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
    ...(options.lease === undefined ? {} : { createMcpLease: async () => options.lease }),
    ...(options.mcpKey === undefined ? {} : { mcpKey: options.mcpKey }),
  })
  runtimes.push(runtime)
  return runtime
}

describe('live ACP input-image proof', () => {
  it.each([true, false, undefined])('uses the real initialize handshake (%s) only while connected', async (image) => {
    const runtime = await fixture(image)
    expect(runtime.inputImageSupported).toBeUndefined()
    await runtime.start()
    expect(runtime.inputImageSupported).toBe(image)
    const closing = runtime.close()
    expect(runtime.inputImageSupported).toBeUndefined()
    await closing
    expect(runtime.inputImageSupported).toBeUndefined()
  })

  it('invalidates cached handshake proof as soon as the MCP lease is revoked', async () => {
    const controller = new AbortController()
    const runtime = await fixture(true, {
      lease: {
        signal: controller.signal,
        servers: [],
        beginPrompt() {},
        endPrompt() {},
        permission: async () => undefined,
        close: async () => undefined,
      },
    })
    await runtime.start()
    expect(runtime.inputImageSupported).toBe(true)
    controller.abort()
    expect(runtime.inputImageSupported).toBeUndefined()
  })

  it('does not retain positive proof when the bridge registration changes', async () => {
    let key = 'initial-registration'
    const runtime = await fixture(true, { mcpKey: () => key })
    await runtime.start()
    expect(runtime.inputImageSupported).toBe(true)
    key = 'replacement-registration'
    expect(runtime.inputImageSupported).toBeUndefined()
  })

  it('invalidates proof after the negotiated connection dies without a clean close', async () => {
    const runtime = await fixture(true)
    await runtime.start()
    expect(runtime.inputImageSupported).toBe(true)
    await expect(runtime.prompt([{ type: 'text', text: 'Exit fixture' }], () => {})).rejects.toThrow()
    expect(runtime.inputImageSupported).toBeUndefined()
  })

  it.each(['exit', 'provider failure'] as const)(
    'invalidates idle transport %s before another RPC tries to observe it',
    async (outcome) => {
      const base = (await sharedTestSubprocess()).seam
      const failed = Promise.withResolvers<never>()
      let handle: AcpSubprocessHandle | undefined
      const subprocess: SubprocessSeam = {
        resolveExecutable: (command, env, signal) => base.resolveExecutable(command, env, signal),
        spawn(spec) {
          handle = base.spawn(spec)
          return new Proxy(handle, {
            get(target, property, receiver) {
              return property === 'done'
                ? Promise.race([target.done, failed.promise])
                : Reflect.get(target, property, receiver)
            },
          })
        },
      }
      const runtime = await fixture(true, { subprocess })
      await runtime.start()
      expect(runtime.inputImageSupported).toBe(true)
      if (outcome === 'exit') {
        handle!.terminate()
        await handle!.done
      } else {
        failed.reject(new Error('fixture provider failed while idle'))
        // Both provider outcome observers run in their already-attached Promise jobs.
        await Promise.resolve()
        await Promise.resolve()
      }
      await expect.poll(() => runtime.inputImageSupported).toBeUndefined()
    },
  )

  it.each([false, true])(
    'preserves Host-body cancellation ownership with a distinct body signal=%s',
    async (distinctBodySignal) => {
      const directoryAbort = new AbortController()
      const userStop = new AbortController()
      const promptStarted = Promise.withResolvers<void>()
      let admissionSignal: AbortSignal | undefined
      let bodySignal: AbortSignal | undefined
      const runtime = await fixture(true, {
        waitForCancel: true,
        lease: {
          signal: new AbortController().signal,
          servers: [],
          beginPrompt(signal, _report, _ordinal, _concluded, body) {
            admissionSignal = signal
            bodySignal = body
          },
          endPrompt() {},
          permission: async () => undefined,
          close: async () => undefined,
        },
      })
      const response = runtime.prompt(
        [{ type: 'text', text: 'Wait' }],
        () => promptStarted.resolve(),
        directoryAbort.signal,
        undefined,
        undefined,
        undefined,
        distinctBodySignal ? { hostBodySignal: userStop.signal } : undefined,
      )
      await promptStarted.promise
      expect(admissionSignal?.aborted).toBe(false)
      expect(bodySignal?.aborted).toBe(false)
      directoryAbort.abort(new Error('Internal directory handoff'))
      await expect(response).resolves.toMatchObject({ stopReason: 'cancelled' })
      expect(admissionSignal?.aborted).toBe(true)
      expect(bodySignal?.aborted).toBe(!distinctBodySignal)
      if (distinctBodySignal) {
        expect(bodySignal).toBe(userStop.signal)
        userStop.abort(new Error('Native user Stop'))
        expect(bodySignal?.aborted).toBe(true)
      }
    },
  )
})
