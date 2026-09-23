import { afterEach, expect, it } from 'vitest'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const runtimes: AcpSessionRuntime[] = []
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())) })

async function fixture(foreignUpdates = false) {
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
  const runtime = new AcpSessionRuntime({ profileId: 'fixture', cwd: process.cwd(),
    config: { command: argv[0]!, args: argv.slice(1), env: {} },
    subprocess: (await sharedTestSubprocess()).seam,
    prepareLaunch: async () => ({ argv, env: {}, spawnPlan: { argv, env: {} } }),
  })
  runtimes.push(runtime)
  await runtime.start()
  return runtime
}

it('does not let external child notifications overwrite the parent controls or usage', async () => {
  const runtime = await fixture(true)
  await runtime.prompt([{type:'text',text:'test'}], () => {})
  expect(runtime.configOptions?.[0]?.currentValue).toBe('code')
  expect(runtime.currentModeId).toBe('code')
  expect(runtime.contextUsage?.used).toBe(100)
})

it.each(['config', 'mode'])('finishes an admitted %s write before dispatching a prompt', async kind => {
  const runtime = await fixture()
  const writing = kind === 'config' ? runtime.setConfigOption('mode','plan') : runtime.setMode('plan')
  const prompting = runtime.prompt([{type:'text',text:'test'}], () => {})
  await expect(Promise.all([writing, prompting])).resolves.toMatchObject([undefined, {stopReason:'end_turn'}])
})

it('does not restart a closed runtime when a prompt was waiting for a configuration write', async () => {
  const runtime = await fixture()
  const writing = runtime.setMode('plan')
  const prompting = runtime.prompt([{type:'text',text:'test'}], () => {})
  const settled = Promise.allSettled([writing, prompting])
  await runtime.close()
  await settled
  expect(runtime.acpSessionId).toBeUndefined()
})
