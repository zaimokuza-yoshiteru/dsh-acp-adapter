import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', '..', 'mock-agent', 'mock-agent.mjs')
const PROMPT: acp.ContentBlock[] = [{ type: 'text', text: 'Keep working until cancelled.' }]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout')
    await sleep(5)
  }
}

let subprocess: SubprocessSeam
const runtimes: AcpSessionRuntime[] = []
const roots: string[] = []

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => await runtime.close()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function createRuntime(
  scenario: string,
  cancelGraceMs?: number,
  onPermissionRequest?: AcpSessionRuntimeOptions['onPermissionRequest'],
): { runtime: AcpSessionRuntime; logPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-runtime-cancel-'))
  roots.push(root)
  const logPath = path.join(root, 'agent.log')
  const argv = [process.execPath, MOCK_AGENT_PATH, `--runtime-cancel-${process.pid}-${String(roots.length)}`]
  const env = { MOCK_SCENARIO: scenario, MOCK_LOG: logPath, MOCK_STEP_DELAY_MS: '50' }
  const runtime = new AcpSessionRuntime({
    profileId: 'runtime-cancel',
    config: { command: process.execPath, args: argv.slice(1), env },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
    ...(cancelGraceMs === undefined ? {} : { cancelGraceMs }),
    ...(onPermissionRequest === undefined ? {} : { onPermissionRequest }),
  })
  runtimes.push(runtime)
  return { runtime, logPath }
}

function createPermissionRaceRuntime(
  onPermissionRequest: NonNullable<AcpSessionRuntimeOptions['onPermissionRequest']>,
  settlePromptImmediately = false,
): { runtime: AcpSessionRuntime; logPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-runtime-permission-'))
  roots.push(root)
  const logPath = path.join(root, 'agent.log')
  const script = `const fs=require('node:fs');const log=(s)=>fs.appendFileSync(${JSON.stringify(logPath)},s+'\\n');const settlePromptImmediately=${JSON.stringify(settlePromptImmediately)};let b='';let promptId;const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');log('started');process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'permission-race',version:'1'},agentCapabilities:{}}});else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'permission-session'}});else if(m.method==='session/prompt'){promptId=m.id;send({jsonrpc:'2.0',id:90,method:'session/request_permission',params:{sessionId:'permission-session',toolCall:{toolCallId:'call-90',title:'Run command',kind:'execute',status:'pending',rawInput:{command:'echo ok'}},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});if(settlePromptImmediately)send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})}else if(m.method==='session/cancel')log('cancel-notification');else if(m.id===90){log('permission-rpc='+m.result.outcome.outcome);if(!settlePromptImmediately)send({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}})}}});process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1<<30);`
  const argv = [process.execPath, '-e', script]
  const env: Record<string, string> = {}
  const runtime = new AcpSessionRuntime({
    profileId: 'runtime-permission-race',
    config: { command: process.execPath, args: argv.slice(1), env },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
    cancelGraceMs: 250,
    onPermissionRequest,
  })
  runtimes.push(runtime)
  return { runtime, logPath }
}

describe('AcpSessionRuntime prompt cancellation', () => {
  it('turn abort sends session/cancel, returns cancelled, and keeps the connection reusable', async () => {
    const { runtime, logPath } = createRuntime('eof-exit')
    const controller = new AbortController()
    let updates = 0
    const pending = runtime.prompt(PROMPT, () => { updates += 1 }, controller.signal)
    await waitFor(() => updates > 0)

    controller.abort(new Error('user stopped'))
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(runtime.isBusy).toBe(false)
    expect(fs.readFileSync(logPath, 'utf8')).toContain('session/cancel sessionId=mock-session-1 turnActive=true')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })
  }, 10_000)

  it('rejects an overlapping prompt without replacing the active prompt cancellation state', async () => {
    const { runtime, logPath } = createRuntime('eof-exit')
    const firstController = new AbortController()
    const secondController = new AbortController()
    let updates = 0
    const first = runtime.prompt(PROMPT, () => { updates += 1 }, firstController.signal)
    await waitFor(() => updates > 0)

    await expect(runtime.prompt(PROMPT, () => undefined, secondController.signal)).rejects.toThrow('ACP_PROMPT_ALREADY_ACTIVE')
    secondController.abort(new Error('rejected prompt stopped'))
    await sleep(20)
    expect(runtime.isBusy).toBe(true)
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('session/cancel sessionId=mock-session-1 turnActive=true')

    firstController.abort(new Error('active prompt stopped'))
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(runtime.isBusy).toBe(false)
    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })
  }, 10_000)

  it('closes an Agent that ignores session/cancel after the configured grace period', async () => {
    const { runtime, logPath } = createRuntime('cancel-stuck', 25)
    const controller = new AbortController()
    let updates = 0
    const startedAt = Date.now()
    const pending = runtime.prompt(PROMPT, () => { updates += 1 }, controller.signal)
    const observed = pending.then(
      () => { throw new Error('expected stuck prompt to reject after cancellation escalation') },
      (error: unknown) => error,
    )
    await waitFor(() => updates > 0)

    controller.abort(new Error('user stopped'))
    await expect(observed).resolves.toBeInstanceOf(Error)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(runtime.isBusy).toBe(false)
    const log = fs.readFileSync(logPath, 'utf8')
    expect(log).toContain('session/cancel sessionId=mock-session-1 turnActive=true')
    expect(log).toContain('cancel-stuck: session/cancel received')
  }, 10_000)

  it('returns a pending permission RPC as cancelled even when the host question ignores abort', async () => {
    let permissionSignal: AbortSignal | undefined
    const permissionStarted = Promise.withResolvers<void>()
    const { runtime, logPath } = createPermissionRaceRuntime(async (_params, signal) => {
      permissionSignal = signal
      permissionStarted.resolve()
      return await new Promise<acp.RequestPermissionResponse>(() => {})
    })
    const controller = new AbortController()
    const pending = runtime.prompt(PROMPT, () => undefined, controller.signal)
    await permissionStarted.promise

    controller.abort(new Error('user stopped'))
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(runtime.isBusy).toBe(false)
    expect(permissionSignal?.aborted).toBe(true)
    await waitFor(() => fs.readFileSync(logPath, 'utf8').includes('permission-rpc=cancelled'))
    expect(fs.readFileSync(logPath, 'utf8')).toContain('cancel-notification')
  }, 10_000)

  it('cancels a pending permission when the Agent settles the prompt first', async () => {
    let permissionSignal: AbortSignal | undefined
    const permissionStarted = Promise.withResolvers<void>()
    const { runtime, logPath } = createPermissionRaceRuntime(async (_params, signal) => {
      permissionSignal = signal
      permissionStarted.resolve()
      return await new Promise<acp.RequestPermissionResponse>(() => {})
    }, true)

    const pending = runtime.prompt(PROMPT, () => undefined)
    await permissionStarted.promise
    await expect(pending).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(runtime.isBusy).toBe(false)
    expect(permissionSignal?.aborted).toBe(true)
    await waitFor(() => fs.readFileSync(logPath, 'utf8').includes('permission-rpc=cancelled'))
  }, 10_000)
})
