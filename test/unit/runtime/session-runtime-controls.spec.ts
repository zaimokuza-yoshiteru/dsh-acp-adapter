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

async function fixture(foreignUpdates = false, diagnosticDshSessionId?: string, mcpLease?: AcpMcpLease) {
  const script = `
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const option = value => [{id:'mode',name:'Mode',type:'select',currentValue:value,options:[{value:'code',name:'Code'},{value:'plan',name:'Plan'}]}];
    const update = (sessionId, update) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
    let writing = false;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r = JSON.parse(line), reply = result => send({jsonrpc:'2.0',id:r.id,result});
      if(r.method==='initialize') reply({protocolVersion:1,agentCapabilities:{}});
      if(r.method==='session/new') reply({sessionId:'parent',configOptions:option('code'),modes:{currentModeId:'code',availableModes:[{id:'code',name:'Code'},{id:'plan',name:'Plan'}]}});
      if(r.method==='session/set_config_option' || r.method==='session/set_mode') {
        writing=true; setTimeout(()=>{writing=false; reply(r.method==='session/set_config_option'?{configOptions:option('plan')}:{})},80);
      }
      if(r.method==='session/prompt') {
        if(writing) return send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'Prompt raced configuration write'}});
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
