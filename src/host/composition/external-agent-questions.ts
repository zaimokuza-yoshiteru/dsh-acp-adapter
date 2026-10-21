import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '../../contract/external-subagent.ts'
import type { AcpNativeUserQuestionService, AcpPermissionQuestionService } from '../../domain/policy/elicitation.ts'

type QuestionRequest = Parameters<AcpNativeUserQuestionService['ask']>[0]

class ExternalPermissionQuestionError extends Error {
  constructor(readonly code: 'ASK_ABORTED' | 'CALLER_NOT_LIVE' | 'DELEGATED_CALLER') {
    super(`ACP permission presentation unavailable: ${code}`)
    this.name = 'ExternalPermissionQuestionError'
  }
}

function sourceText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
}

function shortSessionId(id: string, ids: readonly string[]): string {
  let length = Math.min(8, id.length)
  while (length < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))) length++
  return id.slice(0, length)
}

/**
 * Present an external ACP permission on its live runtime root. The root owns
 * only this native question; the caller retains the child ACP request and its
 * exact option/value mapping and audit. Ordinary child questions never use it.
 *
 * The pinned Gateway sends scoped waterfalls only to owner Peers (which can
 * access every Session), and rejects non-owner replies. No request payload is
 * broadcast as a notification or exposed through a new approval endpoint.
 */
export function externalAgentPermissionQuestions(
  ctx: Context,
  getAgent: () => Agent | undefined,
  native: AcpNativeUserQuestionService,
  locale?: string,
): AcpPermissionQuestionService {
  return {
    async ask(request: QuestionRequest, onPresentation) {
      const agents = ctx.get('agents', false)
      const child = getAgent()
      if (agents === undefined || child === undefined || request.agent !== child || agents.get(child.id) !== child)
        throw new ExternalPermissionQuestionError('CALLER_NOT_LIVE')
      if (request.signal?.aborted) throw new ExternalPermissionQuestionError('ASK_ABORTED')
      if (agents.roots().includes(child)) return native.ask(request)

      const projections = ctx.get('sessionProjections', false)
      if (projections === undefined) throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
      const zh = locale?.toLowerCase().startsWith('zh') === true
      const path: { agent: Agent; name: string }[] = []
      const seen = new Set<Agent>()
      let root = child
      while (!agents.roots().includes(root)) {
        if (seen.has(root) || agents.get(root.id) !== root || root.session.header.origin !== 'subagent')
          throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
        seen.add(root)
        const view = projections.snapshot(root.session, ['subagent', 'acpExecution']).values
        const identity = view.subagent
        if (identity == null || !root.session.isOwnSeq(identity.seq) || view.acpExecution?.externalSubagent === true)
          throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
        const membership = ctx.get('agentTeams', false)?.tryMembership(root)
        path.unshift({
          agent: root,
          name:
            sourceText(membership?.role === 'teammate' ? membership.name : (identity.label ?? '')) ||
            (zh ? '子 Agent' : 'Subagent'),
        })
        // The runtime owner is authoritative. Persisted parentSession is not a
        // permission to route a restored independent fork to an old parent.
        const owners = agents.list().filter((candidate) => agents.isOwnedBy(root.id, candidate))
        if (owners.length !== 1) throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
        root = owners[0]!
      }
      const chain = [root, ...path.map((entry) => entry.agent)]
      const current = () =>
        getAgent() === child &&
        child.status === 'running' &&
        agents.roots().includes(root) &&
        chain.every(
          (agent, index) =>
            agents.get(agent.id) === agent && (index === 0 || agents.isOwnedBy(agent.id, chain[index - 1]!)),
        )
      if (!current()) throw new ExternalPermissionQuestionError('ASK_ABORTED')

      const lifetime = new AbortController()
      const signal = request.signal === undefined ? lifetime.signal : AbortSignal.any([request.signal, lifetime.signal])
      const finished = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<null>()
      const abort = () => cancelled.resolve(null)
      const releases: (() => unknown)[] = []
      signal.addEventListener('abort', abort, { once: true })
      try {
        // Keep no pending approval registry. These effects own only the link
        // between one live ACP request and the native question's lifetime.
        for (const owner of new Set([ctx, ...chain.map((agent) => agent.ctx)])) {
          releases.push(
            owner.effect(
              () => async () => {
                lifetime.abort()
                await finished.promise
              },
              'dsh-acp: delegated permission presentation',
            ),
          )
        }
        releases.push(
          ctx.on(
            'agent/disposed',
            ({ agent }) => {
              if (chain.includes(agent)) lifetime.abort()
            },
            { global: true },
          ),
        )
        if (signal.aborted || !current()) throw new ExternalPermissionQuestionError('ASK_ABORTED')

        const liveIds = agents.list().map((agent) => agent.id)
        const names = path.map((entry) => `${entry.name} · ${shortSessionId(entry.agent.id, liveIds)}`).join(' → ')
        const source = path.map((entry) => `${entry.name} (${entry.agent.id})`).join(' → ')
        let delimiterLength = 1
        for (const match of source.matchAll(/`+/g)) delimiterLength = Math.max(delimiterLength, match[0].length + 1)
        const delimiter = '`'.repeat(delimiterLength)
        const detail = `${zh ? '来源子会话' : 'Source child session'}: ${delimiter} ${source} ${delimiter}`
        onPresentation?.({ rootSessionId: root.id, path: path.map((entry) => entry.agent.id) })
        const question = native.ask({
          agent: root,
          questions: request.questions.map((item) => ({
            ...item,
            ...(item.header === undefined
              ? { question: `${zh ? '子会话授权' : 'Child permission'}: ${names}\n${item.question}` }
              : { header: `${zh ? '子会话授权' : 'Child permission'}: ${names}` }),
            detail: item.detail === undefined ? detail : `${detail}\n\n${item.detail}`,
          })),
          signal,
        })
        const answer = await Promise.race([question, cancelled.promise])
        if (answer === null || signal.aborted || !current()) throw new ExternalPermissionQuestionError('ASK_ABORTED')
        return answer
      } finally {
        finished.resolve()
        signal.removeEventListener('abort', abort)
        await Promise.allSettled(releases.map((release) => release()))
      }
    },
  }
}
