import { afterEach, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'
import { installLiveDiagnosticTrace } from '../../../src/contract/live-diagnostic-trace.ts'
import type { LiveDiagnosticEvent } from '../../../src/contract/live-diagnostic-trace.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const runtimes: AcpSessionRuntime[] = []
const diagnosticRemovers: Array<() => void> = []
afterEach(async () => {
  for (const remove of diagnosticRemovers.splice(0)) remove()
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()))
})

async function fixture(
  foreignUpdates = false,
  diagnosticDshSessionId?: string,
  mcpLease?: AcpMcpLease,
  echoPrompt = false,
  sessionNewUpdates: 'none' | 'both' | 'child' = 'none',
  responseConfig: 'code' | 'empty' | 'omitted' = 'code',
  responseMode: 'code' | 'null' | 'omitted' = 'code',
) {
  const script = `
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const option = value => [{id:'mode',name:'Mode',type:'select',currentValue:value,options:[{value:'code',name:'Code'},{value:'plan',name:'Plan'}]}];
    const update = (sessionId, update) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
    let writing = false;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r = JSON.parse(line), reply = result => send({jsonrpc:'2.0',id:r.id,result});
      if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{}});
      if(r.method==='session/new') {
        if(${sessionNewUpdates !== 'none'}) {
          update('child',{sessionUpdate:'config_option_update',configOptions:option('child')});
          update('child',{sessionUpdate:'current_mode_update',currentModeId:'child-mode'});
        }
        if(${sessionNewUpdates === 'both'}) {
          update('parent',{sessionUpdate:'config_option_update',configOptions:option('plan')});
          update('parent',{sessionUpdate:'current_mode_update',currentModeId:'plan'});
        }
        const result={sessionId:'parent',${responseConfig === 'omitted' ? '' : `configOptions:${responseConfig === 'empty' ? '[]' : "option('code')"},`}${responseMode === 'omitted' ? '' : `modes:${responseMode === 'null' ? 'null' : "{currentModeId:'code',availableModes:[{id:'code',name:'Code'},{id:'plan',name:'Plan'}]}"}`}};
        reply(result);
      }
      if(r.method==='session/set_config_option' || r.method==='session/set_mode') {
        writing=true; setTimeout(()=>{writing=false; reply(r.method==='session/set_config_option'?{configOptions:option('plan')}:{})},80);
      }
      if(r.method==='session/prompt') {
        if(writing) return send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'Prompt raced configuration write'}});
        if(${echoPrompt}) update('parent',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:r.params.prompt.filter(x=>x.type==='text').map(x=>x.text).join('')}});
        update('parent',{sessionUpdate:'usage_update',used:100,size:1000});
        if(${foreignUpdates}) {
          update('child',{sessionUpdate:'config_option_update',configOptions:option('plan')});
          update('child',{sessionUpdate:'current_mode_update',currentModeId:'plan'});
          update('child',{sessionUpdate:'usage_update',used:900,size:1000});
        }
        reply({stopReason:'end_turn'});
      }
    });`
  const argv = [process.execPath, '-e', script]
  const runtime = new AcpSessionRuntime({
    profileId: 'fixture',
    cwd: process.cwd(),
    config: { command: argv[0]!, args: argv.slice(1), env: {} },
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
    ...(mcpLease === undefined ? {} : { createMcpLease: async () => mcpLease }),
    ...(diagnosticDshSessionId === undefined ? {} : { diagnosticDshSessionId }),
  })
  runtimes.push(runtime)
  await runtime.start()
  return runtime
}

it('collects live provider prompt start/end events from the real runtime prompt boundary', async () => {
  const events: LiveDiagnosticEvent[] = []
  const remove = installLiveDiagnosticTrace(
    Object.assign(
      (event: LiveDiagnosticEvent) => {
        events.push(event)
      },
      {
        id: (kind: string, value: unknown) =>
          `h:${createHmac('sha256', 'unit-test-key')
            .update(`${kind}:${JSON.stringify(value)}`)
            .digest('hex')
            .slice(0, 24)}`,
        fingerprint: () => ({ hmac: 'h:0123456789abcdef01234567', bytes: 1, complete: true }),
      },
    ),
  )
  diagnosticRemovers.push(remove)
  const runtime = await fixture(false, 'host-session-123')
  await runtime.prompt([{ type: 'text', text: 'safe fixture prompt' }], () => {})
  const promptEvents = events.filter(
    (event) => event.type === 'adapter-prompt/start' || event.type === 'adapter-prompt/end',
  )
  expect(promptEvents.map((event) => event.type)).toEqual(['adapter-prompt/start', 'adapter-prompt/end'])
  expect(promptEvents[0]).toMatchObject({
    sessionId: `h:${createHmac('sha256', 'unit-test-key').update('dsh-session:"host-session-123"').digest('hex').slice(0, 24)}`,
    promptOrdinal: 1,
  })
  expect(promptEvents[1]).toMatchObject({ stopReason: 'end_turn' })
})

it('does not let external child notifications overwrite the parent controls or usage', async () => {
  const runtime = await fixture(true)
  await runtime.prompt([{ type: 'text', text: 'test' }], () => {})
  expect(runtime.configOptions?.[0]?.currentValue).toBe('code')
  expect(runtime.currentModeId).toBe('code')
  expect(runtime.contextUsage?.used).toBe(100)
})

it.each([
  ['omitted', 'null', 'plan', 'plan'],
  ['code', 'code', 'code', 'code'],
  ['empty', 'code', 'empty', 'code'],
] as const)(
  'keeps parent config/mode pushes during session/new with response config=%s and modes=%s',
  async (config, mode, expectedConfig, expectedMode) => {
    const runtime = await fixture(false, undefined, undefined, false, 'both', config, mode)
    await runtime.prompt([{ type: 'text', text: 'test' }], () => {})
    expect(runtime.configOptions?.[0]?.currentValue).toBe(expectedConfig === 'empty' ? undefined : expectedConfig)
    expect(runtime.currentModeId).toBe(expectedMode)
  },
)

it('ignores session/new config and mode pushes for another session ID', async () => {
  const runtime = await fixture(false, undefined, undefined, false, 'child', 'omitted', 'omitted')
  await runtime.prompt([{ type: 'text', text: 'test' }], () => {})
  expect(runtime.configOptions).toBeUndefined()
  expect(runtime.currentModeId).toBeUndefined()
})

it('does not reuse staged controls after a closed session/new when the next generation uses the same ID', async () => {
  const staged = Promise.withResolvers<void>()
  let launchCount = 0
  const runtime = new AcpSessionRuntime({
    profileId: 'fixture',
    cwd: process.cwd(),
    config: { command: process.execPath, args: [], env: {} },
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => {
      launchCount += 1
      const script = `
        const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
        const update = (sessionId, update) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
        const option = [{id:'mode',name:'Mode',type:'select',currentValue:'plan',options:[{value:'plan',name:'Plan'}]}];
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const r=JSON.parse(line), reply=result=>send({jsonrpc:'2.0',id:r.id,result});
          if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{}});
          if(r.method==='session/new') {
            ${launchCount === 1 ? "update('same-id',{sessionUpdate:'config_option_update',configOptions:option}); update('same-id',{sessionUpdate:'current_mode_update',currentModeId:'plan'});" : ''}
            ${launchCount === 1 ? '' : "reply({sessionId:'same-id'});"}
          }
          if(r.method==='session/prompt') reply({stopReason:'end_turn'});
        });`
      const argv = [process.execPath, '-e', script]
      return { argv, env: {}, spawnPlan: { argv, env: {} } }
    },
    onSessionUpdate(notification) {
      if (notification.sessionId === 'same-id' && notification.update.sessionUpdate === 'config_option_update')
        staged.resolve()
    },
  })
  runtimes.push(runtime)
  await runtime.initialize()

  const firstPrompt = runtime.prompt([{ type: 'text', text: 'first' }], () => {})
  const firstPromptFailure = expect(firstPrompt).rejects.toThrow()
  await staged.promise
  await runtime.close()
  await firstPromptFailure

  await runtime.prompt([{ type: 'text', text: 'second' }], () => {})
  expect(launchCount).toBe(2)
  expect(runtime.configOptions).toBeUndefined()
  expect(runtime.currentModeId).toBeUndefined()
})

it.each(['config', 'mode'])('finishes an admitted %s write before dispatching a prompt', async (kind) => {
  const runtime = await fixture()
  const writing = kind === 'config' ? runtime.setConfigOption('mode', 'plan') : runtime.setMode('plan')
  const prompting = runtime.prompt([{ type: 'text', text: 'test' }], () => {})
  await expect(Promise.all([writing, prompting])).resolves.toMatchObject([undefined, { stopReason: 'end_turn' }])
})

it('does not restart a closed runtime when a prompt was waiting for a configuration write', async () => {
  const runtime = await fixture()
  const writing = runtime.setMode('plan')
  const prompting = runtime.prompt([{ type: 'text', text: 'test' }], () => {})
  const settled = Promise.allSettled([writing, prompting])
  await runtime.close()
  await settled
  expect(runtime.acpSessionId).toBeUndefined()
})

it('claims a prompt before awaiting local feedback flush so concurrent prompts cannot overlap', async () => {
  const flushStarted = Promise.withResolvers<void>()
  const releaseFlush = Promise.withResolvers<void>()
  const mcpLease: AcpMcpLease = {
    signal: new AbortController().signal,
    servers: [],
    beginPrompt() {},
    endPrompt() {},
    async flushHostFeedback() {
      flushStarted.resolve()
      await releaseFlush.promise
    },
    permission() {
      return undefined
    },
    async close() {},
  }
  const runtime = await fixture(false, undefined, mcpLease)
  const first = runtime.prompt([{ type: 'text', text: 'first' }], () => {})
  await flushStarted.promise

  await expect(runtime.prompt([{ type: 'text', text: 'second' }], () => {})).rejects.toThrow(
    'ACP_PROMPT_ALREADY_ACTIVE',
  )
  releaseFlush.resolve()
  await expect(first).resolves.toMatchObject({ stopReason: 'end_turn' })
})

it('forwards successful Host-result evidence and separates bridge instructions in the actual Runtime.prompt', async () => {
  let forwarded: (() => void) | undefined
  const instructions = 'generated bridge instructions'
  const mcpLease: AcpMcpLease = {
    signal: new AbortController().signal,
    instructions,
    servers: [],
    beginPrompt(_signal, _report, _ordinal, _concluded, _body, onSuccessfulToolResult) {
      forwarded = onSuccessfulToolResult
    },
    endPrompt() {},
    permission() {
      return undefined
    },
    async close() {},
  }
  const runtime = await fixture(false, undefined, mcpLease, true)
  let echoed = ''
  let callbackCount = 0
  const callback = () => callbackCount++
  await runtime.prompt(
    [{ type: 'text', text: 'original user content' }],
    (notification) => {
      if (notification.update.sessionUpdate === 'agent_message_chunk')
        echoed += notification.update.content.type === 'text' ? notification.update.content.text : ''
    },
    undefined,
    undefined,
    undefined,
    callback,
  )
  expect(forwarded).toBe(callback)
  forwarded?.()
  expect(callbackCount).toBe(1)
  expect(echoed).toContain('generated bridge instructions\n\noriginal user content')
})
