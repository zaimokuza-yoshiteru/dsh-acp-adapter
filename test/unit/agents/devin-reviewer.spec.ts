import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevinReviewer } from '../../../src/host/approval-review/devin/reviewer.ts'
import { supportsLocalApprovalReview } from '../../../src/contract/approval-review.ts'
import type { AcpSubprocessHandle, AcpSubprocessSpawnSpec } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const action: ToolCallUpdate = {
  toolCallId: 'write:1',
  name: 'write',
  rawInput: { file_path: 'README', content: 'Correct a typo' },
}
const model = 'swe-2-high'

const fixture = `
const fs=require('node:fs'),rl=require('node:readline'),path=require('node:path')
const record=(method,params)=>fs.appendFileSync(process.env.TEST_TRACE,JSON.stringify({method,params})+'\\n')
const send=(m)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n')
let sessions=0
const source=process.env.TEST_EXTENSIONS
const reg=path.join(process.env.XDG_DATA_HOME,'devin','cli','plugins_cache')
function writeRegistry(){
 if(source==='missing')return
 fs.mkdirSync(reg,{recursive:true})
 const json=source==='unknown'?'{"v2":[]}':JSON.stringify({requirements:source==='required'?[{origin:{scope:'org'},required:true}]:[]})
 fs.writeFileSync(path.join(reg,'installed.json'),json,{mode:0o600})
 if(source==='linked')fs.symlinkSync(path.join(reg,'installed.json'),path.join(reg,'resolved.json'))
 else fs.writeFileSync(path.join(reg,'resolved.json'),JSON.stringify({resolutions:source==='resolved'?[{}]:[]}),{mode:0o600})
}
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line)
 if(!m.method || m.id==null)return
 record(m.method,m.params)
 const emit=(update)=>send({method:'session/update',params:{sessionId:m.params.sessionId,update}})
 switch(m.method){
  case 'initialize':send({id:m.id,result:{protocolVersion:1,agentInfo:{name:'affogato',title:'Devin Agent',version:'3000.14.30821'},agentCapabilities:{sessionCapabilities:process.env.TEST_RETIRE==='1'?{}:{close:{}}}}});break
  case 'session/new':writeRegistry();send({id:m.id,result:{sessionId:'r'+ ++sessions,configOptions:[{id:'model',category:'model',name:'Model',type:'select',currentValue:process.env.TEST_MODEL,options:[]}]}});break
  case 'session/prompt':{
   const text=m.params.prompt[0].text
   if(text==='/mcp'){
    if(source==='late')fs.writeFileSync(path.join(reg,'installed.json'),'{"requirements":[{}]}')
    emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:source==='mcp'?'MCP fixture connected':'No MCP servers are configured.'}})
    send({id:m.id,result:{stopReason:'end_turn'}});break
   }
   if(text.includes('fixture-wait'))return
   if(source==='during')fs.writeFileSync(path.join(reg,'installed.json'),'{"requirements":[{}]}')
   if(text.includes('fixture-tool'))emit({sessionUpdate:'tool_call',kind:'read',title:'Read unexpected file',toolCallId:'bad'})
   const json=text.includes('fixture-fenced-high')?'{"risk":"high","reason":"Anonymous access"}':'{"reason":"A local change","risk":"not_high"}'
   const fence=String.fromCharCode(96).repeat(3)
   const answer=text.includes('fixture-summary')?'<summary>Pending</summary>':text.includes('fixture-fenced')?[fence+'json',json,fence].join('\\n'):json
   emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}})
   send({id:m.id,result:{stopReason:'end_turn'}});break
  }
  case 'session/close':send({id:m.id,result:{}});break
 }
})`

describe.skipIf(!supportsLocalApprovalReview(process.platform))('real ACP transport of the isolated reviewer', () => {
  let root: string
  let trace: string
  let profile: { command: string; args: string[]; env: Record<string, string> }
  let reviewer: DevinReviewer
  let returnedModel: string
  let extensions: string
  let spawns: AcpSubprocessSpawnSpec[]
  let retirement: ((handle: AcpSubprocessHandle, signal?: AbortSignal) => Promise<boolean>) | undefined
  const call = (task: string, signal = new AbortController().signal) =>
    reviewer.review({ profile, model, task, toolCall: action, locale: 'en', signal })
  const records = async () =>
    (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reviewer-spec-'))
    trace = join(root, 'trace')
    await writeFile(trace, '')
    await writeFile(join(root, 'server.cjs'), fixture)
    await mkdir(join(root, 'login', 'devin'), { recursive: true })
    await writeFile(join(root, 'login', 'devin', 'credentials.toml'), 'temporary fixture only')
    const { seam } = await sharedTestSubprocess()
    spawns = []
    returnedModel = model
    extensions = 'empty'
    retirement = undefined
    profile = { command: 'devin', args: ['acp'], env: { XDG_DATA_HOME: join(root, 'login') } }
    reviewer = new DevinReviewer({
      localExecution: true,
      resolveExecutable: async () => process.execPath,
      spawn(spec) {
        spawns.push(spec)
        const handle = seam.spawn({
          ...spec,
          argv: [process.execPath, join(root, 'server.cjs')],
          env: {
            ...spec.env,
            TEST_TRACE: trace,
            TEST_MODEL: returnedModel,
            TEST_EXTENSIONS: extensions,
            TEST_RETIRE: retirement ? '1' : '0',
          },
        })
        if (!retirement) return handle
        const observe = retirement
        return {
          stdin: handle.stdin,
          stdout: handle.stdout,
          stderr: handle.stderr,
          done: handle.done,
          terminate: () => handle.terminate(),
          waitForExit: (signal) => observe(handle, signal),
        }
      },
    })
  })
  afterEach(async () => {
    await reviewer.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(root, { force: true, recursive: true })
  })

  it('uses fresh tool-free sessions on one local process, private profiles and a borrowed login link', async () => {
    vi.stubEnv('DEVIN_REFUSAL_FALLBACK', 'unexpected-model')
    await expect(call('Fix a typo')).resolves.toMatchObject({ risk: 'not_high' })
    await expect(call('fixture-fenced-high')).resolves.toEqual({ risk: 'high', reason: 'Anonymous access' })
    expect(spawns).toHaveLength(1)
    const spec = spawns[0]!
    expect(spec.argv.slice(3)).toEqual([
      'acp',
      '--agent-type',
      'summarizer',
      '--model',
      model,
      '--process-model',
      'in-process',
    ])
    expect(spec.env?.DEVIN_REFUSAL_FALLBACK).toBeUndefined()
    const auth = join(spec.env!.XDG_DATA_HOME!, 'devin', 'credentials.toml')
    expect((await lstat(auth)).isSymbolicLink()).toBe(true)
    expect(await readlink(auth)).toBe(join(root, 'login', 'devin', 'credentials.toml'))
    const cfg = JSON.parse(await readFile(spec.argv[2]!, 'utf8'))
    expect(Object.values(cfg.read_config_from).every((v) => v === false)).toBe(true)
    expect(cfg.permissions.deny).toContain('mcp__*')
    const rpc = await records()
    expect(rpc.find((m) => m.method === 'initialize').params.clientCapabilities).toEqual({})
    expect(rpc.filter((m) => m.method === 'session/new').map((m) => m.params)).toEqual(
      Array(2).fill({ cwd: spec.cwd, mcpServers: [] }),
    )
    expect(rpc.filter((m) => m.method === 'session/close').map((m) => m.params.sessionId)).toEqual(['r1', 'r2'])
    await reviewer.dispose()
    expect(existsSync(dirname(spec.cwd))).toBe(false)
    expect(await readFile(join(root, 'login', 'devin', 'credentials.toml'), 'utf8')).toBe('temporary fixture only')
  })

  it('withholds a fenced low verdict on the observed access-expanding configuration', async () => {
    const task = 'Prepare the access configuration. fixture-fenced-low'
    const toolCall = {
      toolCallId: 'access-file',
      kind: 'edit' as const,
      rawInput: {
        file_path: 'public/access-policy.json',
        content: '{"default_read":"public","anonymous_access":true}',
      },
    }
    await expect(
      reviewer.review({ profile, model, task, toolCall, locale: 'en', signal: new AbortController().signal }),
    ).rejects.toThrow(/unavailable/)
  })

  it('never dispatches when the model differs or the business profile uses Devin Cloud', async () => {
    returnedModel = 'unexpected-model'
    await expect(call('Review model')).rejects.toThrow()
    profile.args.push('--cloud')
    await expect(call('Review cloud')).rejects.toThrow()
    expect((await records()).filter((m) => m.method === 'session/prompt')).toHaveLength(0)
    expect(spawns).toHaveLength(1)
  })

  it('discards a completed decision when the deadline expires during mandatory retirement', async () => {
    const deadline = new AbortController()
    const original = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === 15_000 ? deadline.signal : original(ms)))
    retirement = async (handle, signal) => {
      deadline.abort(new DOMException('Review deadline', 'TimeoutError'))
      return handle.waitForExit(signal)
    }
    await expect(call('Fix a typo')).rejects.toMatchObject({ name: 'TimeoutError' })
    expect((await records()).filter((m) => m.method === 'session/prompt')).toHaveLength(2)
  })

  it('requires confirmed managed-range exit to deliver a decision from a retiring worker', async () => {
    retirement = async (handle, signal) => {
      await handle.waitForExit(signal)
      return false
    }
    await expect(call('Fix a typo')).rejects.toThrow(/unavailable/)
    expect((await records()).filter((m) => m.method === 'session/prompt')).toHaveLength(2)
  })

  it('delivers the completed decision after a timely, confirmed retirement', async () => {
    retirement = (handle, signal) => handle.waitForExit(signal)
    await expect(call('Fix a typo')).resolves.toMatchObject({ risk: 'not_high' })
    expect(existsSync(dirname(spawns[0]!.cwd))).toBe(false)
  })

  it('does not resolve a binary or touch a login for a remote or unrecognized subprocess provider', async () => {
    const resolveExecutable = vi.fn()
    const remote = new DevinReviewer({ resolveExecutable, spawn: vi.fn() })
    await expect(
      remote.review({
        profile,
        model,
        task: 'Review',
        toolCall: action,
        locale: 'en',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/unavailable/)
    expect(resolveExecutable).not.toHaveBeenCalled()
    await remote.dispose()
  })

  it.each(['required', 'resolved', 'missing', 'unknown', 'linked', 'late', 'mcp'])(
    'withholds business prompt when extension evidence is %s',
    async (state) => {
      extensions = state
      await expect(call('Business request must stay in DSH')).rejects.toThrow(/unavailable/)
      const sent = (await records()).filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt[0].text)
      expect(sent).toEqual(state === 'late' || state === 'mcp' ? ['/mcp'] : [])
      expect(existsSync(dirname(spawns[0]!.cwd))).toBe(false)
    },
  )

  it('discards an otherwise valid answer when the registry changes during review', async () => {
    extensions = 'during'
    await expect(call('Fix the synthetic typo')).rejects.toThrow(/unavailable/)
    expect((await records()).filter((m) => m.method === 'session/prompt')).toHaveLength(2)
  })

  it('collects abandoned review data after a Host crash without cleaning another live Host', async () => {
    vi.stubEnv('TMPDIR', root)
    const parent = join(root, 'dsh-acp-devin-review-' + process.getuid!())
    await mkdir(parent, { mode: 0o700 })
    // Beyond the PID range on the supported Darwin and Linux platforms.
    const stale = await mkdtemp(join(parent, '99999999-'))
    const live = await mkdtemp(join(parent, process.pid + '-'))
    await call('Fix a typo')
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })

  it.each(['fixture-summary', 'fixture-tool'])('discards the process and declines %s output', async (task) => {
    await expect(call(task)).rejects.toThrow()
    expect(existsSync(dirname(spawns[0]!.cwd))).toBe(false)
  })

  it('stopping one in-flight request preserves another, disposal drains and prevents reopening', async () => {
    const cancel = new AbortController()
    const pending = expect(call('fixture-wait', cancel.signal)).rejects.toThrow()
    await vi.waitFor(async () => expect((await records()).some((m) => m.method === 'session/prompt')).toBe(true))
    await expect(call('Fix a typo')).resolves.toMatchObject({ risk: 'not_high' })
    cancel.abort()
    await pending
    const before = (await records()).filter((m) => m.method === 'session/prompt').length
    const another = expect(call('fixture-wait')).rejects.toThrow()
    await vi.waitFor(async () =>
      expect((await records()).filter((m) => m.method === 'session/prompt').length).toBeGreaterThan(before),
    )
    await reviewer.dispose()
    await another
    expect(spawns).toHaveLength(2)
    expect(spawns.every((spec) => !existsSync(dirname(spec.cwd)))).toBe(true)
    await expect(call('late')).rejects.toThrow()
  })
})
