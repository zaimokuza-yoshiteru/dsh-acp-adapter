import { expect, it, vi } from 'vitest'
import type { AcpPermissionQuestionService } from '../../../src/domain/policy/elicitation.ts'
import {
  createAcpNativePermissionHandler,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpSubprocessHandle } from '../../../src/runtime/process/subprocess.ts'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

// Like the real 2.185.0 peer, each process omits agentInfo. Both deliberately reuse
// all wire identifiers so only the connection and the outstanding request distinguish them.
const peer = String.raw`
const lines=require('node:readline').createInterface({input:process.stdin})
const send=body=>process.stdout.write(JSON.stringify({...body,jsonrpc:'2.0'})+'\n')
let prompt
lines.on('line',line=>{
 const m=JSON.parse(line)
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})
 if(m.method==='session/new') send({id:m.id,result:{sessionId:'same-session'}})
 if(m.method==='session/prompt'){
   prompt=m.id
   send({id:71,method:'session/request_permission',params:{sessionId:'same-session',toolCall:{toolCallId:'same-write',_meta:{'codebuddy.ai/toolName':'Write'},rawInput:{file_path:'note.txt',content:'ok'}},options:[{optionId:'allow_always',kind:'allow_always',name:'Always allow'},{optionId:'allow',kind:'allow_once',name:'Allow once'},{optionId:'reject',kind:'reject_once',name:'Reject'}]}})
 }
 if(m.method==='session/cancel'&&prompt!==undefined){send({id:prompt,result:{stopReason:'cancelled'}});prompt=undefined}
 if(m.id===71&&m.result&&prompt!==undefined){
   send({method:'session/update',params:{sessionId:'same-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result.outcome)}}}})
   send({id:prompt,result:{stopReason:'end_turn'}});prompt=undefined
 }
})
lines.on('close',()=>process.exit(0))
`
it.each(['cancel', 'disconnect'])(
  'does not apply an old CodeBuddy human allow to a new request after %s',
  async (change) => {
    const { seam } = await sharedTestSubprocess()
    const handles: AcpSubprocessHandle[] = []
    const cards: { respond: (choice: string) => void }[] = []
    const ask: AcpPermissionQuestionService['ask'] = ({ questions }) =>
      new Promise((resolve) => {
        cards.push({ respond: (choice) => resolve({ answers: [{ id: questions[0]!.id, selected: [choice] }] }) })
      })
    const records: AcpPermissionAuditRecord[] = []
    const owner = {}
    const handle = createAcpNativePermissionHandler({
      permissionProfile: 'codebuddy',
      getAgent: () => owner,
      permissionQuestions: { ask },
      audit: {
        append: async (r) => {
          records.push(r)
        },
      },
    })
    const argv = [process.execPath, '-e', peer]
    const runtime = new AcpSessionRuntime({
      profileId: 'codebuddy',
      config: { command: argv[0]!, args: argv.slice(1), env: {} },
      subprocess: {
        ...seam,
        spawn(spec) {
          const child = seam.spawn(spec)
          handles.push(child)
          return child
        },
      },
      cwd: process.cwd(),
      prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
      onPermissionRequest: handle,
      refreshSessionAfterCancelledPrompt: () => true,
      cancelGraceMs: 200,
    })
    const wire: string[] = []
    const start = (signal?: AbortSignal) =>
      runtime.prompt(
        [{ type: 'text', text: 'Write a note' }],
        ({ update }) => {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
            wire.push(update.content.text)
        },
        signal,
      )
    try {
      const cancel = new AbortController()
      const first = start(cancel.signal).catch(() => {})
      await vi.waitFor(() => expect(cards).toHaveLength(1))
      if (change === 'cancel') cancel.abort()
      else handles[0]!.terminate()
      await first
      await runtime.close()
      const second = start()
      void second.catch(() => {})
      await vi.waitFor(() => expect(cards).toHaveLength(2))
      const requests = records.flatMap((r) => (r.data.phase === 'asked' ? [r.data] : []))
      expect(requests.map((r) => [r.agentSessionId, r.toolCall.toolCallId])).toEqual([
        ['same-session', 'same-write'],
        ['same-session', 'same-write'],
      ])
      const ids = requests.map((r) => r.requestId)
      expect(new Set(ids).size).toBe(2)
      cards[0]!.respond('Allow once')
      await vi.waitFor(() =>
        expect(records.some((r) => r.data.phase === 'decided' && r.data.requestId === ids[0])).toBe(true),
      )
      expect(records.filter((r) => r.data.phase === 'decided').map((r) => r.data)).toMatchObject([
        { requestId: ids[0], outcome: 'cancelled' },
      ])
      cards[1]!.respond('Reject')
      await second
      expect(wire.map((x) => JSON.parse(x))).toEqual([{ outcome: 'selected', optionId: 'reject' }])
      expect(records.filter((r) => r.data.phase === 'decided').map((r) => r.data)).toMatchObject([
        { requestId: ids[0], outcome: 'cancelled' },
        { requestId: ids[1], outcome: 'selected', selectedOptionKind: 'reject_once' },
      ])
    } finally {
      for (const c of cards) c.respond('Reject')
      await runtime.close()
    }
  },
)
