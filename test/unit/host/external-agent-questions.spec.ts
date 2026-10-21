import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { externalAgentPermissionQuestions } from '../../../src/host/composition/external-agent-questions.ts'
import {
  createAcpNativePermissionHandler,
  withDshTeamPermissionPresentation,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'

// Use the pinned, published service through the existing Host installation.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const NativeQuestions = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-user-questions')).href)
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const live = new Map<string, Agent>()
  const owners = new Map<string, Agent>()
  const facts = new Map<
    string,
    { subagent: { seq: number; label: string } | null; acpExecution: { externalSubagent: boolean } }
  >()
  const agents = {
    get: (id: string) => live.get(id),
    list: () => [...live.values()],
    roots: () => [...live.values()].filter((agent) => !owners.has(agent.id)),
    isOwnedBy: (id: string, owner: Agent) => owners.get(id) === owner,
  }
  ctx.provide('agents', agents as never)
  ctx.provide('sessionProjections', {
    register: () => () => {},
    snapshot: (session: Agent['session']) => ({ values: facts.get(session.id) }),
  } as never)
  await ctx.plugin(NativeQuestions.default)
  const native = ctx.get('userQuestions') as unknown as AcpNativeUserQuestionService
  const add = (id: string, parent?: Agent): Agent => {
    const scope = new Context()
    contexts.push(scope)
    const agent = {
      id,
      ctx: scope,
      status: parent === undefined ? 'idle' : 'running',
      options: { provider: parent ? 'acp-test' : 'native' },
      session: {
        id,
        header: { ...(parent ? { origin: 'subagent', parentSession: parent.id } : {}) },
        isOwnSeq: () => true,
      },
    } as unknown as Agent
    live.set(id, agent)
    if (parent) owners.set(id, parent)
    facts.set(id, {
      subagent: parent ? { seq: 1, label: `Worker ${id}` } : null,
      acpExecution: { externalSubagent: false },
    })
    return agent
  }
  const root = add('root')
  const child = add('child', root)
  return {
    ctx,
    live,
    owners,
    facts,
    native,
    add,
    root,
    child,
    presenter: (agent = child, locale = 'en') =>
      externalAgentPermissionQuestions(ctx, () => live.get(agent.id), native, locale),
  }
}

const question = {
  id: 'permission-scope',
  header: 'Permission request',
  question: 'Choose scope',
  options: [{ label: 'Once' }, { label: 'Session' }],
}
type Answer = Awaited<ReturnType<AcpNativeUserQuestionService['ask']>>

describe('external permission root presentation', () => {
  it.each([
    ['root', 'spawn_teammate'],
    ['child', 'spawn_teammate'],
    ['root', 'send_message'],
    ['child', 'send_message'],
  ] as const)(
    'keeps %s %s task details and authorization choices under the same native request',
    async (owner, tool) => {
      const f = await fixture()
      const agent = f[owner]
      const task = 'Review every case, then report the results.\n'.repeat(60)
      const rawInput =
        tool === 'spawn_teammate'
          ? {
              name: 'parser-reviewer',
              description: 'Review parser',
              prompt: task,
              context: 'fresh',
              model: 'explicit-model',
              extra_scope: { path: '/restricted' },
            }
          : { target: 'lead', message: task, extra_scope: { path: '/restricted' } }
      const options = [
        { optionId: 'once', kind: 'allow_once' as const, name: 'Allow once' },
        { optionId: 'session', kind: 'allow_always' as const, name: 'Allow only this tool for this session' },
        { optionId: 'deny', kind: 'reject_once' as const, name: 'Reject' },
      ]
      const ask = vi.fn(async (request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => ({
        answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![1]!.label] }],
      }))
      f.ctx.on('user-questions/request', ask as never)
      const audit: AcpPermissionAuditRecord[] = []
      const handler = createAcpNativePermissionHandler({
        getAgent: () => agent,
        userQuestions: f.native,
        permissionQuestions: f.presenter(agent),
        audit: {
          append: async (record) => {
            audit.push(record)
          },
        },
      })
      const rawCall = { toolCallId: `${owner}-${tool}`, name: tool, title: tool, rawInput }
      const result = await handler({
        sessionId: `external-${owner}`,
        toolCall: withDshTeamPermissionPresentation(rawCall, { tool, workspace: '/shared/workspace' }),
        options,
      })
      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'session' } })
      const request = ask.mock.calls[0]![0]
      const question = request.questions[0]!
      expect(request.agent).toBe(f.root)
      expect(question.header).toBe(owner === 'root' ? 'Permission request' : 'Child permission: Worker child · child')
      expect(question.question).not.toContain('Review every case')
      expect(question.question).toContain(tool === 'spawn_teammate' ? 'Member: parser-reviewer' : 'Recipient: lead')
      expect(question.question).toContain('extra_scope')
      expect(question.question).toContain('/restricted')
      expect(question.detail).toContain(JSON.stringify(task).slice(1, -1))
      if (owner === 'child') expect(question.detail).toContain('Worker child (child)')
      expect(question.options!.map(({ label }) => label)).toEqual(options.map(({ name }) => name))
      expect(audit[1]?.data).toMatchObject({
        agentSessionId: `external-${owner}`,
        toolCallId: rawCall.toolCallId,
        optionId: 'session',
      })
      expect(rawCall.rawInput).toBe(rawInput)
    },
  )

  it.each(['native', 'acp-test'])(
    'preserves child decision identity under an idle %s root and leaves direct child questions unavailable',
    async (provider) => {
      const f = await fixture()
      Object.assign(f.root.options, { provider })
      const nativeAsk = vi.fn(async (request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
        expect(request.agent).toBe(f.root)
        expect(request.questions[0]?.header).toBe('子会话授权: Worker child · child')
        expect(request.questions[0]?.question).toBe('Command: echo complete')
        expect(request.questions[0]?.detail).toContain('Worker child (child)')
        return { answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![1]!.label] }] }
      })
      f.ctx.on('user-questions/request', nativeAsk as never)
      await expect(f.native.ask({ agent: f.child, questions: [question] })).rejects.toMatchObject({
        code: 'DELEGATED_CALLER',
      })
      const audit: AcpPermissionAuditRecord[] = []
      const handler = createAcpNativePermissionHandler({
        userQuestions: f.native,
        permissionQuestions: f.presenter(f.child, 'zh'),
        getAgent: () => f.child,
        audit: {
          append: async (record) => {
            audit.push(record)
          },
        },
      })
      expect(
        await handler({
          sessionId: 'external-child',
          toolCall: { toolCallId: 'child-call', kind: 'execute', rawInput: { command: 'echo complete' } },
          options: [
            { optionId: 'once-id', kind: 'allow_once', name: 'Once' },
            { optionId: 'session-id', kind: 'allow_always', name: 'Session' },
          ],
        }),
      ).toEqual({ outcome: { outcome: 'selected', optionId: 'session-id' } })
      expect(nativeAsk).toHaveBeenCalledOnce()
      expect(audit.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
      expect(audit[1]?.data).toMatchObject({
        agentSessionId: 'external-child',
        toolCallId: 'child-call',
        optionId: 'session-id',
        selectedOptionKind: 'allow_always',
        presentation: { rootSessionId: 'root', path: ['child'] },
      })
      const asked = audit[0]!.data
      const decided = audit[1]!.data
      expect('requestId' in asked ? asked.requestId : undefined).toBe(
        'requestId' in decided ? decided.requestId : undefined,
      )
    },
  )

  it('uses runtime ownership through a nested native child and includes the complete source path', async () => {
    const f = await fixture()
    const nested = f.add('nested', f.child)
    Object.assign(nested.session.header, { parentSession: 'unrelated-persisted-parent' })
    const ask = vi.fn(async (request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      expect(request.agent).toBe(f.root)
      expect(request.questions[0]?.header).toBe('Child permission: Worker child · child → Worker nested · nested')
      expect(request.questions[0]?.question).toBe('Choose scope')
      expect(request.questions[0]?.detail).toContain('Worker child (child) → Worker nested (nested)')
      return { answers: [{ id: question.id, selected: ['Session'] }] }
    })
    f.ctx.on('user-questions/request', ask as never)
    await expect(f.presenter(nested).ask({ agent: nested, questions: [question] })).resolves.toEqual({
      answers: [{ id: question.id, selected: ['Session'] }],
    })
  })

  it('keeps Markdown and backticks in source labels inside one compact inline code span', async () => {
    const f = await fixture()
    const label = '` [link](https://example.test) `` ![image](https://example.test/image) ``` **bold**'
    f.facts.get('child')!.subagent!.label = label
    const nested = f.add('nested', f.child)
    const originalDetail = '**Command:**\n\n```sh\necho unchanged\n```'
    const ask = vi.fn(async (request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      const presented = request.questions[0]!
      expect(presented.header).toBe(`Child permission: ${label} · child → Worker nested · nested`)
      expect(presented.question).toBe('Choose scope')
      expect(presented.detail).toBe(
        `Source child session: \`\`\`\` ${label} (child) → Worker nested (nested) \`\`\`\`\n\n${originalDetail}`,
      )
      return { answers: [{ id: question.id, selected: ['Session'] }] }
    })
    f.ctx.on('user-questions/request', ask as never)
    await f.presenter(nested).ask({ agent: nested, questions: [{ ...question, detail: originalDetail }] })
    expect(ask).toHaveBeenCalledOnce()
  })

  it('distinguishes equal source names with short IDs and extends colliding prefixes', async () => {
    const f = await fixture()
    const first = f.add('12345678-a111', f.root)
    const second = f.add('12345678-b222', f.root)
    for (const agent of [first, second]) f.facts.get(agent.id)!.subagent!.label = 'Writer'
    const headers: string[] = []
    f.ctx.on('user-questions/request', ((request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      headers.push(request.questions[0]!.header!)
      expect(request.questions[0]?.detail).toContain(headers.length === 1 ? first.id : second.id)
      expect(request.questions[0]?.question).toBe('Choose scope')
      return { answers: [{ id: question.id, selected: ['Once'] }] }
    }) as never)
    await f.presenter(first).ask({ agent: first, questions: [question] })
    await f.presenter(second).ask({ agent: second, questions: [question] })
    expect(headers).toEqual(['Child permission: Writer · 12345678-a', 'Child permission: Writer · 12345678-b'])
    expect(headers.some((header) => header.includes(first.id) || header.includes(second.id))).toBe(false)
  })

  it('keeps a legacy question without a visible operation header in the expanded-detail format', async () => {
    const f = await fixture()
    f.ctx.on('user-questions/request', ((request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      expect(request.questions[0]?.header).toBeUndefined()
      expect(request.questions[0]?.question).toBe('Child permission: Worker child · child\nChoose scope')
      expect(request.questions[0]?.detail).toContain('Command: exact legacy operation')
      return { answers: [] }
    }) as never)
    const { header: _header, ...legacy } = question
    await f.presenter().ask({
      agent: f.child,
      questions: [{ ...legacy, detail: 'Command: exact legacy operation' }],
    })
  })

  it('leaves an independent runtime root on its own native question surface despite persisted ancestry', async () => {
    const f = await fixture()
    f.owners.delete(f.child.id)
    const ask = vi.fn(async (request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      expect(request.agent).toBe(f.child)
      expect(request.questions).toEqual([question])
      return { answers: [] }
    })
    f.ctx.on('user-questions/request', ask as never)
    await f.presenter().ask({ agent: f.child, questions: [question] })
    expect(ask).toHaveBeenCalledOnce()
  })

  it.each(['observed', 'inherited', 'ordinary', 'missing-descriptor', 'cycle'] as const)(
    'refuses %s lineage without exposing the payload to a root',
    async (kind) => {
      const f = await fixture()
      if (kind === 'observed') f.facts.get('child')!.acpExecution.externalSubagent = true
      if (kind === 'inherited') Object.assign(f.child.session, { isOwnSeq: () => false })
      if (kind === 'ordinary') Object.assign(f.child.session.header, { origin: undefined })
      if (kind === 'missing-descriptor') f.facts.get('child')!.subagent = null
      if (kind === 'cycle') f.owners.set(f.root.id, f.child)
      const ask = vi.fn()
      f.ctx.on('user-questions/request', ask)
      await expect(f.presenter().ask({ agent: f.child, questions: [question] })).rejects.toMatchObject({
        code: 'DELEGATED_CALLER',
      })
      expect(ask).not.toHaveBeenCalled()
    },
  )

  it.each([
    'signal',
    'child-disposal',
    'root-disposal',
    'adapter-disposal',
    'replacement',
    'ownership-change',
  ] as const)('cancels %s and cannot apply a late answer', async (kind) => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<Answer>()
    let shownSignal: AbortSignal | undefined
    f.ctx.on('user-questions/request', ((request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      shownSignal = request.signal
      entered.resolve()
      return answer.promise
    }) as never)
    const abort = new AbortController()
    const pending = f.presenter().ask({ agent: f.child, questions: [question], signal: abort.signal })
    const result = expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await entered.promise
    if (kind === 'signal') abort.abort()
    if (kind === 'child-disposal') await f.child.ctx.fiber.dispose()
    if (kind === 'root-disposal') await f.root.ctx.fiber.dispose()
    if (kind === 'adapter-disposal') await f.ctx.fiber.dispose()
    if (kind === 'replacement') f.live.set(f.child.id, { ...f.child } as Agent)
    if (kind === 'ownership-change') f.owners.set(f.child.id, f.add('other'))
    answer.resolve({ answers: [{ id: question.id, selected: ['Session'] }] })
    await result
    expect(shownSignal?.aborted).toBe(true)
  })

  it('keeps simultaneous child permissions and the root own question separate', async () => {
    const f = await fixture()
    const second = f.add('second', f.root)
    const waiting = new Map<
      string,
      { request: Parameters<AcpNativeUserQuestionService['ask']>[0]; done: PromiseWithResolvers<Answer> }
    >()
    f.ctx.on('user-questions/request', ((request: Parameters<AcpNativeUserQuestionService['ask']>[0]) => {
      const done = Promise.withResolvers<Answer>()
      waiting.set(request.questions[0]!.id, { request, done })
      return done.promise
    }) as never)
    const child = f.presenter().ask({ agent: f.child, questions: [{ ...question, id: 'child' }] })
    const other = f.presenter(second).ask({ agent: second, questions: [{ ...question, id: 'second' }] })
    const root = f.native.ask({ agent: f.root, questions: [{ ...question, id: 'root' }] })
    expect([...waiting.keys()]).toEqual(['child', 'second', 'root'])
    expect(waiting.get('root')?.request.questions[0]?.question).toBe('Choose scope')
    for (const [id, entry] of waiting)
      entry.done.resolve({ answers: [{ id, selected: [id === 'second' ? 'Once' : 'Session'] }] })
    expect(await Promise.all([child, other, root])).toEqual([
      { answers: [{ id: 'child', selected: ['Session'] }] },
      { answers: [{ id: 'second', selected: ['Once'] }] },
      { answers: [{ id: 'root', selected: ['Session'] }] },
    ])
  })
})
