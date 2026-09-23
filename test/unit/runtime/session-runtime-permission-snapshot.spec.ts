import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { createPermissionCheckAudit } from '../../../src/domain/policy/events.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'

const PROMPT: acp.ContentBlock[] = [{ type: 'text', text: 'permission snapshot test' }]

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
  onPermissionRequest: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>,
  mode: 'raw-input' | 'content-json' | 'content-json-prefixed' | 'content-json-unrelated' | 'content-json-late' = 'raw-input',
  previousStatus: 'in_progress' | 'completed' = 'in_progress',
  mcpLease?: AcpMcpLease,
  onPermissionCheck?: AcpSessionRuntimeOptions['onPermissionCheck'],
): AcpSessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-runtime-permission-snapshot-'))
  roots.push(root)
  const initialInput = mode === 'raw-input'
    ? `rawInput:{command:'printf SNAPSHOT_OK'},`
    : `content:[{type:'content',content:{type:'text',text:'{\\"command\\":\\"printf SNAPSHOT_OK\\"}'}}],`
  const permissionCallId = mode === 'content-json-prefixed'
    ? '0:shared-call'
    : mode === 'content-json-unrelated' ? 'permission-only-id' : 'shared-call'
  const permissionKind = mode === 'raw-input' ? '' : `,kind:'execute'`
  const updateSessionId = 'permission-snapshot-session'
  const updates = `send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'tool_call',toolCallId:'shared-call',title:'Run visible command',name:'terminal',kind:'execute',status:'pending',${initialInput}locations:[{path:'/tmp/snapshot'}]}}});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'tool_call_update',toolCallId:'shared-call',title:null,status:'${previousStatus}',rawOutput:{phase:'awaiting-permission'}}}});`
  const firstPrompt = mode === 'content-json-late'
    ? `permission(permissionId);setTimeout(()=>{${updates}},40);`
    : `${updates}permission(permissionId);`
  const requestContent = mode === 'raw-input' ? '' : `,content:[{type:'content',content:{type:'text',text:'Requesting approval to run the visible command'}}]`
  const script = `let b='';let promptSeq=0;const promptIds=new Map();const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');const permission=(id)=>send({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:'permission-snapshot-session',toolCall:{toolCallId:'${permissionCallId}'${permissionKind}${requestContent}},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'permission-snapshot',version:'1'},agentCapabilities:{}}});else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'permission-snapshot-session'}});else if(m.method==='session/prompt'){promptSeq+=1;const permissionId=100+promptSeq;promptIds.set(permissionId,m.id);if(promptSeq===1){${firstPrompt}}else permission(permissionId)}else if(promptIds.has(m.id)){send({jsonrpc:'2.0',id:promptIds.get(m.id),result:{stopReason:'end_turn'}})}}});process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1<<30);`
  const argv = [process.execPath, '-e', script]
  const env: Record<string, string> = {}
  const runtime = new AcpSessionRuntime({
    profileId: 'runtime-permission-snapshot',
    config: { command: process.execPath, args: argv.slice(1), env },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env }, ...(mcpLease === undefined ? {} : { mcpLease }) }),
    onPermissionRequest,
    ...(onPermissionCheck === undefined ? {} : { onPermissionCheck }),
  })
  runtimes.push(runtime)
  return runtime
}

describe('AcpSessionRuntime prompt-scoped permission snapshots', () => {
  it('audits a bridge rejection without opening a native user approval', async () => {
    let nativeRequests = 0
    const records: unknown[] = []
    const response: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    const lease: AcpMcpLease = {
      signal: new AbortController().signal, servers: [], beginPrompt() {}, endPrompt() {}, async close() {},
      inspectPermission: () => ({ reason: 'invalid-tool-name', identitySource: 'devin-meta', response }),
      permission: () => response,
    }
    const runtime = createRuntime(async () => { nativeRequests++; return response }, 'raw-input', 'in_progress', lease,
      async (check, request) => { records.push(createPermissionCheckAudit(check, request.sessionId, request.toolCall.toolCallId)) })
    await runtime.prompt(PROMPT, () => undefined)
    expect(nativeRequests).toBe(0)
    expect(records[0]).toMatchObject({ phase: 'bridge', reason: 'invalid-tool-name', identitySource: 'devin-meta' })
  })
  it('audits automatic permission without saving the capability response, and fails closed when audit fails', async () => {
    for (const auditFails of [false, true]) {
      const records: unknown[] = []
      let answers = 0, nativeRequests = 0
      const response: acp.RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'CAPABILITY_SECRET' } }
      const lease: AcpMcpLease = {
        signal: new AbortController().signal, servers: [], beginPrompt() {}, endPrompt() {}, async close() {},
        inspectPermission: () => ({ reason: 'auto-approved', toolName: 'send_message', response }),
        permission: () => { answers++; return response },
      }
      const runtime = createRuntime(async () => { nativeRequests++; return response }, 'raw-input', 'in_progress', lease,
        async (check, request) => {
          if (auditFails) throw new Error('audit unavailable')
          records.push(createPermissionCheckAudit(check, request.sessionId, request.toolCall.toolCallId))
        })
      await runtime.prompt(PROMPT, () => undefined)
      expect(nativeRequests).toBe(0)
      expect(answers).toBe(auditFails ? 0 : 1)
      expect(records).toHaveLength(auditFails ? 0 : 1)
      expect(JSON.stringify(records)).not.toContain('CAPABILITY_SECRET')
      if (!auditFails) expect(records[0]).toMatchObject({ phase: 'bridge', reason: 'auto-approved', toolName: 'send_message', toolCallId: 'shared-call' })
    }
  })

  it('checks wire identity before presenting a normalized native approval without changing arguments', async () => {
    const checked: acp.ToolCallUpdate[] = [], shown: acp.ToolCallUpdate[] = []
    const runtime = createRuntime(async request => {
      shown.push(request.toolCall)
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'raw-input', 'in_progress', {
      signal: new AbortController().signal, servers: [], beginPrompt() {}, endPrompt() {},
      permission(request) { checked.push(request.toolCall); return undefined },
      presentTool(call) { return { ...call, title: 'bash', name: 'bash', kind: 'execute' } },
      async close() {},
    })
    await runtime.prompt(PROMPT, () => undefined)
    expect(checked[0]).toMatchObject({ name: 'terminal', title: 'Run visible command', rawInput: { command: 'printf SNAPSHOT_OK' } })
    expect(shown[0]).toMatchObject({ name: 'bash', title: 'bash', kind: 'execute', rawInput: { command: 'printf SNAPSHOT_OK' } })
    expect(shown[0]?.toolCallId).toBe(checked[0]?.toolCallId)
  })
  it('enriches an id-only permission from sparse current-prompt updates without leaking into the next prompt', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    })

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })
    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.toolCall).toEqual({
      toolCallId: 'shared-call',
      title: 'Run visible command',
      name: 'terminal',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'printf SNAPSHOT_OK' },
      rawOutput: { phase: 'awaiting-permission' },
      locations: [{ path: '/tmp/snapshot' }],
    })
    expect(requests[1]?.toolCall).toEqual({ toolCallId: 'shared-call' })
  })

  it('recovers a complete execute command from streamed JSON content for an id-only permission request', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.toolCall.rawInput).toEqual({ command: 'printf SNAPSHOT_OK' })
  })

  it('joins Kimi numeric permission namespaces to the preceding unprefixed tool update', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json-prefixed')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests[0]?.toolCall).toMatchObject({
      toolCallId: '0:shared-call',
      title: 'Run visible command',
      rawInput: { command: 'printf SNAPSHOT_OK' },
    })
  })

  it.each(['in_progress', 'completed'] as const)('does not borrow an unrelated command from a sole %s snapshot', async status => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json-unrelated', status)

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests[0]?.toolCall).toEqual({
      toolCallId: 'permission-only-id',
      kind: 'execute',
      content: [{ type: 'content', content: { type: 'text', text: 'Requesting approval to run the visible command' } }],
    })
  })

  it('waits briefly for Kimi tool JSON that arrives after the permission request', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json-late')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests[0]?.toolCall.rawInput).toEqual({ command: 'printf SNAPSHOT_OK' })
  })

})
