import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { createPermissionCheckAudit } from '../../../src/domain/policy/events.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'
import { Context } from '@deepseek-ai/cordis'
import { createDshToolBridge } from '../../../src/host/tools/bridge.ts'
import { fakeToolBatch } from '../../fixtures/tool-batch-testing.ts'

const PROMPT: acp.ContentBlock[] = [{ type: 'text', text: 'permission snapshot test' }]

let subprocess: SubprocessSeam
const runtimes: AcpSessionRuntime[] = []
const roots: string[] = []
const bridgeCleanups: Array<() => Promise<unknown>> = []

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => await runtime.close()))
  for (const close of bridgeCleanups.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function createRuntime(
  onPermissionRequest: NonNullable<AcpSessionRuntimeOptions['onPermissionRequest']>,
  mode:
    | 'raw-input'
    | 'content-json'
    | 'content-json-prefixed'
    | 'content-json-unrelated'
    | 'content-json-late'
    | 'devin-mcp-bare-name'
    | 'bridge-tool' = 'raw-input',
  previousStatus: 'in_progress' | 'completed' = 'in_progress',
  mcpLease?: AcpMcpLease,
  onPermissionCheck?: AcpSessionRuntimeOptions['onPermissionCheck'],
  cancelGraceMs = 5_000,
  echoPermissionResult = false,
): AcpSessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-runtime-permission-snapshot-'))
  roots.push(root)
  const initialInput =
    mode === 'raw-input' || mode === 'devin-mcp-bare-name' || mode === 'bridge-tool'
      ? `rawInput:{command:'printf SNAPSHOT_OK'},`
      : `content:[{type:'content',content:{type:'text',text:'{\\"command\\":\\"printf SNAPSHOT_OK\\"}'}}],`
  const permissionCallId =
    mode === 'content-json-prefixed'
      ? '0:shared-call'
      : mode === 'content-json-unrelated'
        ? 'permission-only-id'
        : 'shared-call'
  const permissionKind = mode === 'raw-input' ? '' : `,kind:'execute'`
  const updateSessionId = 'permission-snapshot-session'
  const updateTitle = mode === 'devin-mcp-bare-name' ? 'Calling jira_get_issue from dsh' : 'Run visible command'
  const updateName =
    mode === 'devin-mcp-bare-name'
      ? 'jira_get_issue'
      : mode === 'bridge-tool'
        ? `mcp__${mcpLease!.servers[0]!.name}__present`
        : 'terminal'
  const updates = `send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'tool_call',toolCallId:'shared-call',title:'${updateTitle}',name:'${updateName}',kind:'execute',status:'pending',${initialInput}locations:[{path:'/tmp/snapshot'}]}}});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'tool_call_update',toolCallId:'shared-call',title:null,status:'${previousStatus}',rawOutput:{phase:'awaiting-permission'}}}});`
  const firstPrompt =
    mode === 'content-json-late'
      ? `permission(permissionId);setTimeout(()=>{${updates}},40);`
      : `${updates}permission(permissionId);`
  const requestContent =
    mode === 'raw-input'
      ? ''
      : `,content:[{type:'content',content:{type:'text',text:'Requesting approval to run the visible command'}}]`
  const permissionEcho = echoPermissionResult
    ? `send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'${updateSessionId}',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}}}});`
    : ''
  const script = `let b='';let promptSeq=0;const promptIds=new Map();const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');const permission=(id)=>send({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:'permission-snapshot-session',toolCall:{toolCallId:'${permissionCallId}'${permissionKind}${requestContent}},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'permission-snapshot',version:'1'},agentCapabilities:{}}});else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'permission-snapshot-session'}});else if(m.method==='session/prompt'){promptSeq+=1;const permissionId=100+promptSeq;promptIds.set(permissionId,m.id);if(promptSeq===1){${firstPrompt}}else permission(permissionId)}else if(promptIds.has(m.id)){${permissionEcho}send({jsonrpc:'2.0',id:promptIds.get(m.id),result:{stopReason:'end_turn'}})}}});process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1<<30);`
  const argv = [process.execPath, '-e', script]
  const env: Record<string, string> = {}
  const runtime = new AcpSessionRuntime({
    profileId: 'runtime-permission-snapshot',
    config: { command: process.execPath, args: argv.slice(1), env },
    subprocess,
    cwd: root,
    cancelGraceMs,
    prepareLaunch: async () => ({
      argv,
      env,
      spawnPlan: { argv, env },
      ...(mcpLease === undefined ? {} : { mcpLease }),
    }),
    onPermissionRequest,
    ...(onPermissionCheck === undefined ? {} : { onPermissionCheck }),
  })
  runtimes.push(runtime)
  return runtime
}

async function permissionBridge(policy: () => Promise<'ask' | 'auto'>) {
  const agent = { id: 'permission-snapshot-session', inbox: { nextStep: [], nextTurn: [] }, inject: vi.fn() }
  const definitions = new Map(
    ['present', 'todo_write'].map((name) => [
      name,
      {
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
      },
    ]),
  )
  const hidden = new Set<string>()
  const tools = {
    schemas: () => [...definitions.values()].filter((definition) => !hidden.has(definition.name)),
    get: (name: string) => (hidden.has(name) ? undefined : definitions.get(name)),
    executable: (name: string) => (hidden.has(name) ? undefined : definitions.get(name)),
    execute: fakeToolBatch(async () => ({ content: [{ type: 'text', text: 'done' }] })),
  }
  const services: Record<string, unknown> = { tools, agents: { get: () => agent } }
  const listeners = new Map<string, (...args: any[]) => void>()
  const owner = new Context()
  owner.provide('tools', tools as never)
  bridgeCleanups.push(() => owner.fiber.dispose())
  const ctx = {
    get: (name: string) => services[name],
    tools,
    inject: owner.inject.bind(owner),
    on: (name: string, listener: (...args: any[]) => void) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  } as unknown as Context
  const lease = (await createDshToolBridge(
    ctx,
    agent.id,
    { mcpCapabilities: { http: true } },
    undefined,
    policy,
    undefined,
    [...definitions.values()],
  ))!
  bridgeCleanups.push(() => lease.close())
  return {
    lease,
    withdraw(name: string, notify = true) {
      hidden.add(name)
      if (notify) listeners.get('tools/change')!()
    },
  }
}

describe('AcpSessionRuntime prompt-scoped permission snapshots', () => {
  it.each(['before-answer', 'after-answer', 'unrelated-tool', 'before-answer-without-event'] as const)(
    'keeps a displayed Ask bound to its exact tool when withdrawn %s',
    async (timing) => {
      const bridge = await permissionBridge(async () => 'ask')
      const shown = Promise.withResolvers<AbortSignal | undefined>()
      const answer = Promise.withResolvers<acp.RequestPermissionResponse>()
      const runtime = createRuntime(
        (_request, signal) => {
          shown.resolve(signal)
          return answer.promise
        },
        'bridge-tool',
        'in_progress',
        bridge.lease,
        undefined,
        5000,
        true,
      )
      const received: string[] = []
      const prompting = runtime.prompt(PROMPT, ({ update }) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          received.push(update.content.text)
      })
      const signal = await shown.promise
      const allow: acp.RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow' } }
      if (timing === 'after-answer') answer.resolve(allow)
      bridge.withdraw(timing === 'unrelated-tool' ? 'todo_write' : 'present', timing !== 'before-answer-without-event')
      expect(bridge.lease.signal.aborted).toBe(false)
      expect(signal?.aborted).toBe(timing === 'before-answer' || timing === 'after-answer')
      answer.resolve(allow)
      await prompting
      expect(JSON.parse(received.join(''))).toEqual(
        timing === 'unrelated-tool' ? allow : { outcome: { outcome: 'cancelled' } },
      )
    },
  )

  it.each(['ask', 'auto'] as const)(
    'settles withdrawal during a pending %s policy read before that read returns',
    async (policy) => {
      let armed = false
      const entered = Promise.withResolvers<void>()
      const resolved = Promise.withResolvers<'ask' | 'auto'>()
      const bridge = await permissionBridge(async () => {
        if (!armed) return policy
        entered.resolve()
        return resolved.promise
      })
      const shown = vi.fn(async (): Promise<acp.RequestPermissionResponse> => ({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }))
      const runtime = createRuntime(shown, 'bridge-tool', 'in_progress', bridge.lease, undefined, 5000, true)
      const received: string[] = []
      armed = true
      const prompting = runtime.prompt(PROMPT, ({ update }) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          received.push(update.content.text)
      })
      await entered.promise
      bridge.withdraw('present')
      try {
        await prompting
        expect(shown).not.toHaveBeenCalled()
        expect(JSON.parse(received.join(''))).toEqual({ outcome: { outcome: 'cancelled' } })
      } finally {
        resolved.resolve(policy)
      }
    },
  )

  it('revalidates an automatic target after asynchronous audit even without a directory event', async () => {
    const bridge = await permissionBridge(async () => 'auto')
    const audited = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    const shown = vi.fn(async (): Promise<acp.RequestPermissionResponse> => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    }))
    const runtime = createRuntime(
      shown,
      'bridge-tool',
      'in_progress',
      bridge.lease,
      async (check) => {
        expect(check.reason).toBe('auto-approved')
        audited.resolve()
        await completed.promise
      },
      5000,
      true,
    )
    const received: string[] = []
    const prompting = runtime.prompt(PROMPT, ({ update }) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        received.push(update.content.text)
    })
    await audited.promise
    bridge.withdraw('present', false)
    completed.resolve()
    await prompting
    expect(shown).not.toHaveBeenCalled()
    expect(JSON.parse(received.join(''))).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('keeps the stream claimed past the local drain grace and admits a new prompt only after settlement', async () => {
    let pending = true
    let releaseDrain!: () => void
    const drain = new Promise<void>((resolve) => (releaseDrain = resolve))
    let beginPromptCount = 0
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt() {
        beginPromptCount++
      },
      endPrompt() {},
      drainPrompt: () => drain,
      hasPendingCalls: () => pending,
      waitForCallsSettled: () => drain,
      async close() {},
      permission: () => undefined,
    }
    const runtime = createRuntime(
      async () => ({ outcome: { outcome: 'cancelled' } }),
      'raw-input',
      'in_progress',
      lease,
      undefined,
      15,
    )

    const firstPrompt = runtime.prompt(PROMPT, () => undefined)
    await vi.waitFor(() => expect(runtime.hostSettlementPending).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(runtime.isBusy).toBe(true)
    await expect(runtime.prompt(PROMPT, () => undefined)).rejects.toThrow('ACP_PROMPT_ALREADY_ACTIVE')
    expect(beginPromptCount).toBe(1)

    pending = false
    releaseDrain()
    await expect(firstPrompt).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(runtime.hostSettlementPending).toBe(false)
    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(beginPromptCount).toBe(2)
  })

  it('passes host report evidence only into each active lease prompt and ends that lease prompt', async () => {
    const received: Array<(() => void) | undefined> = []
    let active: (() => void) | undefined
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt(_signal, onTeamReport) {
        active = onTeamReport
        received.push(onTeamReport)
      },
      endPrompt() {
        active = undefined
      },
      async close() {},
      permission: () => undefined,
    }
    const runtime = createRuntime(
      async () => ({ outcome: { outcome: 'cancelled' } }),
      'raw-input',
      'in_progress',
      lease,
    )
    const first = vi.fn(),
      second = vi.fn()
    await runtime.prompt(PROMPT, () => undefined, undefined, first)
    expect(received[0]).toBe(first)
    expect(active).toBeUndefined()
    await runtime.prompt(PROMPT, () => undefined, undefined, second)
    expect(received[1]).toBe(second)
    expect(active).toBeUndefined()
  })
  it('passes independent terminal-tool evidence through each active lease prompt', async () => {
    const received: Array<(() => void) | undefined> = []
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt(_signal, _onTeamReport, _ordinal, onTurnConcluded) {
        received.push(onTurnConcluded)
      },
      endPrompt() {},
      async close() {},
      permission: () => undefined,
    }
    const runtime = createRuntime(
      async () => ({ outcome: { outcome: 'cancelled' } }),
      'raw-input',
      'in_progress',
      lease,
    )
    const first = vi.fn()
    const second = vi.fn()
    await runtime.prompt(PROMPT, () => undefined, undefined, undefined, first)
    await runtime.prompt(PROMPT, () => undefined, undefined, undefined, second)
    expect(received).toEqual([first, second])
  })
  it('audits a bridge rejection without opening a native user approval', async () => {
    let nativeRequests = 0
    const records: unknown[] = []
    const response: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt() {},
      endPrompt() {},
      async close() {},
      inspectPermission: () => ({ reason: 'invalid-tool-name', identitySource: 'devin-meta', response }),
      permission: () => response,
    }
    const runtime = createRuntime(
      async () => {
        nativeRequests++
        return response
      },
      'raw-input',
      'in_progress',
      lease,
      async (check, request) => {
        records.push(createPermissionCheckAudit(check, request.sessionId, request.toolCall.toolCallId))
      },
    )
    await runtime.prompt(PROMPT, () => undefined)
    expect(nativeRequests).toBe(0)
    expect(records[0]).toMatchObject({ phase: 'bridge', reason: 'invalid-tool-name', identitySource: 'devin-meta' })
  })
  it('audits automatic permission without saving the capability response, and fails closed when audit fails', async () => {
    for (const auditFails of [false, true]) {
      const records: unknown[] = []
      let answers = 0,
        nativeRequests = 0
      const response: acp.RequestPermissionResponse = {
        outcome: { outcome: 'selected', optionId: 'CAPABILITY_SECRET' },
      }
      const lease: AcpMcpLease = {
        signal: new AbortController().signal,
        servers: [],
        beginPrompt() {},
        endPrompt() {},
        async close() {},
        inspectPermission: () => ({ reason: 'auto-approved', toolName: 'send_message', response }),
        permission: () => {
          answers++
          return response
        },
      }
      const runtime = createRuntime(
        async () => {
          nativeRequests++
          return response
        },
        'raw-input',
        'in_progress',
        lease,
        async (check, request) => {
          if (auditFails) throw new Error('audit unavailable')
          records.push(createPermissionCheckAudit(check, request.sessionId, request.toolCall.toolCallId))
        },
      )
      await runtime.prompt(PROMPT, () => undefined)
      expect(nativeRequests).toBe(0)
      // The exact inspected response is reused after the audit; permission()
      // is never asked to resolve the same policy a second time.
      expect(answers).toBe(0)
      expect(records).toHaveLength(auditFails ? 0 : 1)
      expect(JSON.stringify(records)).not.toContain('CAPABILITY_SECRET')
      if (!auditFails)
        expect(records[0]).toMatchObject({
          phase: 'bridge',
          reason: 'auto-approved',
          toolName: 'send_message',
          toolCallId: 'shared-call',
        })
    }
  })

  it('keeps an audited Ask decision manual even if a legacy resolver would now auto-approve', async () => {
    const response: acp.RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'user-once' } }
    let legacyResolutions = 0
    let nativeRequests = 0
    const records: unknown[] = []
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt() {},
      endPrompt() {},
      async close() {},
      inspectPermission: () => ({ reason: 'approval-required' }),
      permission: () => {
        legacyResolutions++
        return { outcome: { outcome: 'selected', optionId: 'auto' } }
      },
    }
    const runtime = createRuntime(
      async () => {
        nativeRequests++
        return response
      },
      'raw-input',
      'in_progress',
      lease,
      async (check, request) => {
        records.push(createPermissionCheckAudit(check, request.sessionId, request.toolCall.toolCallId))
      },
    )
    await runtime.prompt(PROMPT, () => undefined)
    expect(nativeRequests).toBe(1)
    expect(legacyResolutions).toBe(0)
    expect(records[0]).toMatchObject({ phase: 'bridge', reason: 'approval-required' })
  })

  it.each([
    ['identity-unmatched', false, 'inspection'],
    ['approval-required', false, 'inspection'],
    ['identity-unmatched', false, 'audit'],
    ['identity-unmatched', true, 'audit'],
  ] as const)(
    'fences a closed MCP lease for %s permission (matching title: %s, closed during %s)',
    async (reason, titleMatchesCurrentTool, phase) => {
      const leaseAbort = new AbortController()
      const shown = vi.fn(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }))
      const lease: AcpMcpLease = {
        signal: leaseAbort.signal,
        servers: [],
        beginPrompt() {},
        endPrompt() {},
        async close() {},
        permission: () => undefined,
        inspectPermission: () => {
          if (phase === 'inspection') leaseAbort.abort()
          return { reason, titleMatchesCurrentTool }
        },
      }
      const received: string[] = []
      const runtime = createRuntime(
        shown,
        'raw-input',
        'in_progress',
        lease,
        async () => {
          if (phase === 'audit') leaseAbort.abort()
        },
        5_000,
        true,
      )
      await runtime.prompt(PROMPT, ({ update }) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          received.push(update.content.text)
      })
      const independent = reason === 'identity-unmatched' && !titleMatchesCurrentTool
      expect(shown).toHaveBeenCalledTimes(independent ? 1 : 0)
      expect(JSON.parse(received.join(''))).toEqual({
        outcome: independent ? { outcome: 'selected', optionId: 'allow' } : { outcome: 'cancelled' },
      })
    },
  )

  it.each([
    ['identity-unmatched', 'before-answer', false],
    ['identity-unmatched', 'after-answer', false],
    ['approval-required', 'before-answer', false],
    ['approval-required', 'after-answer', false],
    ['identity-unmatched', 'before-answer', true],
    ['identity-unmatched', 'after-answer', true],
  ] as const)(
    'keeps the %s approval lifetime correctly scoped when its MCP lease closes %s (matching title: %s)',
    async (reason, timing, titleMatchesCurrentTool) => {
      const leaseAbort = new AbortController()
      const pending = Promise.withResolvers<acp.RequestPermissionResponse>()
      const shown = Promise.withResolvers<AbortSignal | undefined>()
      const lease: AcpMcpLease = {
        signal: leaseAbort.signal,
        servers: [],
        beginPrompt() {},
        endPrompt() {},
        async close() {},
        permission: () => undefined,
        inspectPermission: () => ({ reason, titleMatchesCurrentTool }),
      }
      const received: string[] = []
      const runtime = createRuntime(
        (_request, signal) => {
          shown.resolve(signal)
          return pending.promise
        },
        'raw-input',
        'in_progress',
        lease,
        undefined,
        5_000,
        true,
      )
      const prompt = runtime.prompt(PROMPT, ({ update }) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          received.push(update.content.text)
      })
      const approvalSignal = await shown.promise
      if (timing === 'after-answer') pending.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
      leaseAbort.abort()
      const independent = reason === 'identity-unmatched' && !titleMatchesCurrentTool
      expect.soft(approvalSignal?.aborted).toBe(!independent)
      // A late answer must not revive a revoked bridge operation. The same
      // closure is irrelevant to an independently owned native Agent tool.
      pending.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
      await prompt
      expect(JSON.parse(received.join(''))).toEqual({
        outcome: independent ? { outcome: 'selected', optionId: 'allow' } : { outcome: 'cancelled' },
      })
    },
  )

  it('still cancels native approval on prompt cancellation after an unrelated MCP lease has closed', async () => {
    const leaseAbort = new AbortController()
    const promptAbort = new AbortController()
    const shown = Promise.withResolvers<AbortSignal | undefined>()
    const pending = Promise.withResolvers<acp.RequestPermissionResponse>()
    const lease: AcpMcpLease = {
      signal: leaseAbort.signal,
      servers: [],
      beginPrompt() {},
      endPrompt() {},
      async close() {},
      permission: () => undefined,
      inspectPermission: () => ({ reason: 'identity-unmatched' }),
    }
    const received: string[] = []
    const runtime = createRuntime(
      (_request, signal) => {
        shown.resolve(signal)
        return pending.promise
      },
      'raw-input',
      'in_progress',
      lease,
      undefined,
      5_000,
      true,
    )
    const prompt = runtime.prompt(
      PROMPT,
      ({ update }) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          received.push(update.content.text)
      },
      promptAbort.signal,
    )
    const approvalSignal = await shown.promise
    leaseAbort.abort()
    promptAbort.abort()
    pending.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await prompt
    expect(approvalSignal?.aborted).toBe(true)
    expect(JSON.parse(received.join(''))).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('checks wire identity before presenting a normalized native approval without changing arguments', async () => {
    const checked: acp.ToolCallUpdate[] = [],
      shown: acp.ToolCallUpdate[] = []
    const runtime = createRuntime(
      async (request) => {
        shown.push(request.toolCall)
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
      'raw-input',
      'in_progress',
      {
        signal: new AbortController().signal,
        servers: [],
        beginPrompt() {},
        endPrompt() {},
        permission(request) {
          checked.push(request.toolCall)
          return undefined
        },
        presentTool(call) {
          return { ...call, title: 'bash', name: 'bash', kind: 'execute' }
        },
        async close() {},
      },
    )
    await runtime.prompt(PROMPT, () => undefined)
    expect(checked[0]).toMatchObject({
      name: 'terminal',
      title: 'Run visible command',
      rawInput: { command: 'printf SNAPSHOT_OK' },
    })
    expect(shown[0]).toMatchObject({
      name: 'bash',
      title: 'bash',
      kind: 'execute',
      rawInput: { command: 'printf SNAPSHOT_OK' },
    })
    expect(shown[0]?.toolCallId).toBe(checked[0]?.toolCallId)
  })
  it('preserves Devin bare native name plus complete DSH title when enriching an id-only permission request', async () => {
    const checked: acp.ToolCallUpdate[] = []
    let nativeRequests = 0
    const lease: AcpMcpLease = {
      signal: new AbortController().signal,
      servers: [],
      beginPrompt() {},
      endPrompt() {},
      async close() {},
      permission() {
        return undefined
      },
      inspectPermission(request) {
        checked.push(request.toolCall)
        return {
          reason: 'approval-required',
          toolName: 'jira_get_issue',
          identitySource: 'devin-title',
        }
      },
    }
    const runtime = createRuntime(
      async () => {
        nativeRequests++
        return { outcome: { outcome: 'cancelled' } }
      },
      'devin-mcp-bare-name',
      'in_progress',
      lease,
    )

    await runtime.prompt(PROMPT, () => undefined)

    expect(nativeRequests).toBe(1)
    expect(checked[0]).toMatchObject({
      toolCallId: 'shared-call',
      name: 'jira_get_issue',
      title: 'Calling jira_get_issue from dsh',
      kind: 'execute',
      rawInput: { command: 'printf SNAPSHOT_OK' },
    })
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

  it('does not turn content text into executable permission input', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.toolCall.rawInput).toBeUndefined()
  })

  it('treats numeric prefixes as part of an opaque permission id', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json-prefixed')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests[0]?.toolCall).toMatchObject({
      toolCallId: '0:shared-call',
      kind: 'execute',
    })
    expect(requests[0]?.toolCall.rawInput).toBeUndefined()
    expect(requests[0]?.toolCall.title).toBeUndefined()
  })

  it.each(['in_progress', 'completed'] as const)(
    'does not borrow an unrelated command from a sole %s snapshot',
    async (status) => {
      const requests: acp.RequestPermissionRequest[] = []
      const runtime = createRuntime(
        async (params) => {
          requests.push(structuredClone(params))
          return { outcome: { outcome: 'selected', optionId: 'allow' } }
        },
        'content-json-unrelated',
        status,
      )

      await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

      expect(requests[0]?.toolCall).toEqual({
        toolCallId: 'permission-only-id',
        kind: 'execute',
        content: [
          { type: 'content', content: { type: 'text', text: 'Requesting approval to run the visible command' } },
        ],
      })
    },
  )

  it('does not wait for late content text to become permission input', async () => {
    const requests: acp.RequestPermissionRequest[] = []
    const runtime = createRuntime(async (params) => {
      requests.push(structuredClone(params))
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    }, 'content-json-late')

    await expect(runtime.prompt(PROMPT, () => undefined)).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(requests[0]?.toolCall.rawInput).toBeUndefined()
  })
})
