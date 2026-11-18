import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type * as acp from '@agentclientprotocol/sdk'
import { createDshToolBridge } from '../../../src/host/tools/bridge.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('revokes a title-only manual target without granting identity or cancelling independent Agent permissions', async () => {
  const owner = new Context()
  cleanups.push(() => owner.fiber.dispose())
  const agent = { id: 'lead', inbox: { nextStep: [], nextTurn: [] } }
  const definitions = new Map(
    ['target', 'unrelated'].map((name) => [
      name,
      { name, description: name, parameters: { type: 'object' as const, properties: {} } },
    ]),
  )
  const tools = {
    get: (name: string) => definitions.get(name),
    executable: (name: string) => definitions.get(name),
  }
  owner.provide('tools', tools as never)
  const listeners = new Map<string, () => void>()
  const ctx = {
    inject: owner.inject.bind(owner),
    get: (name: string) =>
      name === 'tools'
        ? tools
        : name === 'agents'
          ? { get: (id: string) => (id === agent.id ? agent : undefined) }
          : undefined,
    on: (name: string, callback: () => void) => {
      listeners.set(name, callback)
      return () => listeners.delete(name)
    },
  } as unknown as Context
  const lease = await createDshToolBridge(
    ctx,
    agent.id,
    { mcpCapabilities: { http: true } },
    'antigravity',
    async () => 'auto',
    undefined,
    [...definitions.values()],
  )
  if (lease === undefined) throw new Error('Missing bridge fixture')
  cleanups.push(() => lease.close())
  lease.beginPrompt(new AbortController().signal)
  const server = lease.servers[0]!
  const request: acp.RequestPermissionRequest = {
    sessionId: 'acp',
    toolCall: { toolCallId: 'title-only', title: `${server.name}_target` },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  }
  const inspection = await lease.inspectPermission!(request)
  expect(inspection).toMatchObject({
    reason: 'identity-unmatched',
    titleMatchesCurrentTool: true,
  })
  expect(inspection).not.toHaveProperty('response')
  const signal = lease.permissionSignal!(request)
  expect(signal).toBeDefined()
  expect(signal!.aborted).toBe(false)
  expect(lease.validatePermissionDecision!(request)).toBe(true)
  const native: acp.RequestPermissionRequest = {
    ...request,
    toolCall: { toolCallId: 'native', name: 'read_file', title: 'Read an Agent file' },
  }
  expect(await lease.inspectPermission!(native)).toMatchObject({ reason: 'identity-unmatched' })
  expect(lease.permissionSignal!(native)).toBeUndefined()

  definitions.delete('unrelated')
  listeners.get('tools/change')!()
  expect(signal!.aborted).toBe(false)
  expect(lease.validatePermissionDecision!(request)).toBe(true)

  definitions.delete('target')
  listeners.get('tools/change')!()
  expect(signal!.aborted).toBe(true)
  expect(lease.validatePermissionDecision!(request)).toBe(false)
  expect(lease.signal.aborted).toBe(false)
  expect(await lease.inspectPermission!(native)).toMatchObject({ reason: 'identity-unmatched' })
  expect(lease.permissionSignal!(native)).toBeUndefined()
})

it.each(['unchanged', 'ended', 'replaced'] as const)(
  'rechecks the captured Codex manual elicitation admission at reply time without a tools/change event (%s)',
  async (change) => {
    const target = new AbortController()
    let currentAdmission = { active: true }
    let capturedAdmission: typeof currentAdmission | undefined
    const elicitationSignal = vi.fn(() => {
      capturedAdmission = currentAdmission
      return target.signal
    })
    const validateElicitationDecision = vi.fn(
      () => capturedAdmission === currentAdmission && capturedAdmission?.active === true,
    )
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt() {},
      endPrompt() {},
      async close() {},
      permission: () => undefined,
      elicitationSignal,
      validateElicitationDecision,
      elicitation: () => undefined,
    }
    const shown = Promise.withResolvers<AbortSignal | undefined>()
    const answer = Promise.withResolvers<acp.CreateElicitationResponse>()
    const { seam } = await sharedTestSubprocess()
    // This peer reports the actual RPC response, not the local handler result.
    const script = String.raw`
      let buffer = '', promptId;
      const send = value => process.stdout.write(JSON.stringify(value) + '\n');
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentInfo:{name:'codex',version:'fixture'},agentCapabilities:{}}});
          else if (message.method === 'session/new') send({jsonrpc:'2.0',id:message.id,result:{sessionId:'acp'}});
          else if (message.method === 'session/prompt') {
            promptId = message.id;
            send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'acp',update:{sessionUpdate:'tool_call',toolCallId:'target',title:'Host tool',status:'pending',rawInput:{server:'host',tool:'target'},_meta:{is_mcp_tool_call:true}}}});
            send({jsonrpc:'2.0',id:900,method:'elicitation/create',params:{mode:'form',sessionId:'acp',toolCallId:'target',message:'Allow the tool?',_meta:{codex_approval_kind:'mcp_tool_call'},requestedSchema:{type:'object',properties:{persist:{type:'string',enum:['once']}},required:['persist']}}});
          } else if (message.id === 900) {
            send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'acp',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(message.result)}}}});
            send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
          }
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `
    const argv = [process.execPath, '-e', script]
    const runtime = new AcpSessionRuntime({
      profileId: 'elicitation-admission-fixture',
      config: { command: process.execPath, args: argv.slice(1), env: {} },
      subprocess: seam,
      cwd: process.cwd(),
      prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
      createMcpLease: async () => lease,
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      onElicitationRequest: async (_params, signal) => {
        shown.resolve(signal)
        return await answer.promise
      },
    })
    cleanups.push(() => runtime.close())
    const received: string[] = []
    const prompt = runtime.prompt([{ type: 'text', text: 'Ask the Host tool permission' }], ({ update }) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        received.push(update.content.text)
    })
    const signal = await shown.promise
    expect(signal?.aborted).toBe(false)
    if (change === 'ended') currentAdmission.active = false
    else if (change === 'replaced') currentAdmission = { active: true }
    // No event or abort was emitted: the reply boundary must query the owner.
    expect(target.signal.aborted).toBe(false)
    answer.resolve({ action: 'accept', content: { persist: 'once' } })
    await prompt
    expect(elicitationSignal).toHaveBeenCalledOnce()
    expect(validateElicitationDecision).toHaveBeenCalledTimes(2)
    expect(JSON.parse(received.join(''))).toEqual(
      change === 'unchanged' ? { action: 'accept', content: { persist: 'once' } } : { action: 'cancel' },
    )
  },
)
