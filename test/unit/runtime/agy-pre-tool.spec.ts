import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'
import { AgyPreToolCalls } from '../../../src/runtime/session/agy-pre-tool.ts'
import { HOOK_UNAVAILABLE, type AgyPreToolUseReply } from '../../../src/runtime/process/agy-hook-wire.ts'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const input = {
  sessionId: 'remote',
  cwd: '/work',
  toolName: 'run_command',
  args: { CommandLine: 'printf test', WaitMsBeforeAsync: 100 },
}
const call: ToolCallUpdate = {
  toolCallId: 'one',
  kind: 'execute',
  status: 'in_progress',
  rawInput: { ...input.args, toolSummary: 'Test' },
}

it('correlates exact execution arguments, requires a unique live call, and keeps call IDs prompt-local', async () => {
  const owner = new AgyPreToolCalls()
  const evaluate = vi.fn(async (): Promise<AgyPreToolUseReply> => ({ decision: 'deny', reason: 'rule' }))
  const controller = new AbortController()
  const calls = new Map([['one', call]])
  const decide = (facts = input) => owner.decide(facts, calls, controller.signal, evaluate)
  expect(await decide({ ...input, args: { ...input.args, WaitMsBeforeAsync: 222 } })).toBe(HOOK_UNAVAILABLE)
  calls.set('other', { ...call, toolCallId: 'other' })
  expect(await decide()).toBe(HOOK_UNAVAILABLE)
  calls.set('other', { ...call, toolCallId: 'other', status: 'failed' })
  expect((await decide()).decision).toBe('deny')
  expect((await decide()).decision).toBe('deny')
  expect(evaluate).toHaveBeenCalledTimes(1)
  const changed = { ...input, args: { ...input.args, CommandLine: 'printf changed' } }
  calls.set('one', { ...call, rawInput: changed.args })
  expect(await decide(changed)).toBe(HOOK_UNAVAILABLE)
  expect(evaluate).toHaveBeenCalledTimes(1)
  expect((await owner.decide(changed, new Map(calls), controller.signal, evaluate)).decision).toBe('deny')
  expect(evaluate).toHaveBeenCalledTimes(2)
})

it('coalesces pending duplicates and withholds a stale result after cancellation', async () => {
  const owner = new AgyPreToolCalls()
  const gate = Promise.withResolvers<AgyPreToolUseReply>()
  const evaluate = vi.fn(() => gate.promise)
  const controller = new AbortController()
  const calls = new Map([['one', call]])
  const first = owner.decide(input, calls, controller.signal, evaluate)
  const repeat = owner.decide(input, calls, controller.signal, evaluate)
  expect(evaluate).toHaveBeenCalledTimes(1)
  controller.abort()
  gate.resolve({ decision: 'deny', reason: 'late' })
  expect(await first).toBe(HOOK_UNAVAILABLE)
  expect(await repeat).toBe(HOOK_UNAVAILABLE)
})

it.each(['1.5.12', 'unverified'])(
  'binds the hook to the negotiated version %s, directory and original prompt lifetime',
  async (version) => {
    const cwd = process.cwd()
    const script = `
    const lines = require('node:readline').createInterface({input:process.stdin})
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n')
    let prompt
    lines.on('line', line => {
      const msg = JSON.parse(line)
      if(msg.method==='initialize') send({id:msg.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'Antigravity ACP Server',version:process.argv[1]}}})
      else if(msg.method==='session/new') send({id:msg.id,result:{sessionId:'remote'}})
      else if(msg.method==='session/prompt'){
        prompt=msg.id
        send({method:'session/update',params:{sessionId:'remote',update:{sessionUpdate:'tool_call',title:'Print sample',...${JSON.stringify(call)}}}})
      } else if(msg.method==='session/cancel') send({id:prompt,result:{stopReason:'cancelled'}})
    })`
    const argv = [process.execPath, '-e', script, version]
    const evaluate = vi.fn(async (): Promise<AgyPreToolUseReply> => ({ decision: 'deny', reason: 'receipt' }))
    type Hook = NonNullable<Parameters<AcpSessionRuntimeOptions['prepareLaunch']>[2]>
    let callback: Hook | undefined
    const runtime = new AcpSessionRuntime({
      profileId: 'verified-test',
      config: { command: argv[0]!, args: argv.slice(1), env: {} },
      cwd,
      subprocess: (await sharedTestSubprocess()).seam,
      hasAgyPreToolPolicy: () => true,
      onAgyPreToolUse: evaluate,
      prepareLaunch: async (_config, _cwd, hook) => {
        callback = hook
        return { argv, env: {}, spawnPlan: { argv, env: {} } }
      },
    })
    const controller = new AbortController()
    try {
      await runtime.start()
      const facts = { ...input, cwd }
      const invoke = (req = facts) => callback!(req, new AbortController().signal)
      expect(await invoke()).toEqual(HOOK_UNAVAILABLE)
      const updated = Promise.withResolvers<void>()
      const turn = runtime.prompt(
        [{ type: 'text', text: 'first' }],
        (notification) => {
          if (notification.update.sessionUpdate === 'tool_call') updated.resolve()
        },
        controller.signal,
      )
      await updated.promise
      expect(await invoke({ ...facts, sessionId: 'another' })).toEqual(HOOK_UNAVAILABLE)
      expect(await invoke({ ...facts, cwd: '/dsh-hook-fixture-missing-directory' })).toEqual(HOOK_UNAVAILABLE)
      expect(await invoke()).toEqual(version === '1.5.12' ? { decision: 'deny', reason: 'receipt' } : HOOK_UNAVAILABLE)
      controller.abort()
      expect((await turn).stopReason).toBe('cancelled')
      expect(await invoke()).toEqual(HOOK_UNAVAILABLE)
      expect(evaluate).toHaveBeenCalledTimes(version === '1.5.12' ? 1 : 0)
    } finally {
      controller.abort()
      await runtime.close()
    }
  },
)
