import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

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
  const updates = `send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'tool_call',toolCallId:'shared-call',title:'Run visible command',name:'terminal',kind:'execute',status:'pending',${initialInput}locations:[{path:'/tmp/snapshot'}]}}});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'tool_call_update',toolCallId:'shared-call',title:null,status:'in_progress',rawOutput:{phase:'awaiting-permission'}}}});`
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
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
    onPermissionRequest,
  })
  runtimes.push(runtime)
  return runtime
}

describe('AcpSessionRuntime prompt-scoped permission snapshots', () => {
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

  it('uses one unique complete execute snapshot when Kimi permission ids are unrelated', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json-unrelated')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests[0]?.toolCall).toMatchObject({
      toolCallId: 'permission-only-id',
      title: 'Run visible command',
      rawInput: { command: 'printf SNAPSHOT_OK' },
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
