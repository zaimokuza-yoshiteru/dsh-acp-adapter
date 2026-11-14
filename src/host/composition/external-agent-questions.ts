import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '../../contract/external-subagent.ts'
import type { AcpNativeUserQuestionService, AcpPermissionQuestionService } from '../../domain/policy/elicitation.ts'

import { captureSubagentTree, localSubagentIdentity, subagentPath } from '../subagent/tree.ts'

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
      const tree = captureSubagentTree(ctx, child)
      if (tree === undefined) {
        if (ctx.get('subagents', false) === undefined && child.session.header.origin !== 'subagent')
          return native.ask(request)
        throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
      }
      if (tree.root === child) return native.ask(request)
      if (localSubagentIdentity(ctx, child) === undefined) throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
      const root = tree.root
      const rows = await tree.descendants(request.signal)
      const path = subagentPath(root.id, child.id, rows)
      if (path === undefined) throw new ExternalPermissionQuestionError('DELEGATED_CALLER')
      const zh = locale?.toLowerCase().startsWith('zh') === true
      // Creators may be dormant. Only the native runtime root and this caller
      // own the live question; catalog ancestors supply display/resource facts.
      const chain = [root, child]
      const current = () =>
        getAgent() === child &&
        child.status === 'running' &&
        tree.current() &&
        localSubagentIdentity(ctx, child) !== undefined
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
        const names = path
          .map((entry) => `${sourceText(entry.name)} · ${shortSessionId(entry.sessionId, liveIds)}`)
          .join(' → ')
        const source = path.map((entry) => `${sourceText(entry.name)} (${entry.sessionId})`).join(' → ')
        let delimiterLength = 1
        for (const match of source.matchAll(/`+/g)) delimiterLength = Math.max(delimiterLength, match[0].length + 1)
        const delimiter = '`'.repeat(delimiterLength)
        const detail = `${zh ? '来源子会话' : 'Source child session'}: ${delimiter} ${source} ${delimiter}`
        onPresentation?.({ rootSessionId: root.id, path: path.map((entry) => entry.sessionId) })
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
