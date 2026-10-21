import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

type JsonValue = Extract<ToolExecutionResult, { isError: false }>['value']

type ModelFact = { readonly currentModel: string }

function publicMember({ id: _id, name, ...details }: TeamMemberView) {
  return { target: name, ...details }
}

/** Correct the native roster's constructor model only when its complete returned facts still match. */
export function installTeamMemberModelFacts(
  ctx: Context,
  readModel: (id: string, signal: AbortSignal) => Promise<ModelFact | undefined>,
): void {
  let active = true
  const detach = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (
      !active ||
      decision.kind !== 'accept' ||
      Object.hasOwn(decision, 'value') ||
      Object.hasOwn(decision, 'content') ||
      result.isError ||
      (exec.name !== 'list_agents' && exec.name !== 'spawn_teammate') ||
      exec.agent === undefined ||
      exec.signal.aborted
    )
      return decision
    try {
      const teams = ctx.get('agentTeams', false)
      const caller = exec.agent
      const membership = teams?.tryMembership(caller)
      if (teams === undefined || membership === undefined) return decision
      const roster = teams.listMembers(caller)
      const rows =
        exec.name === 'list_agents'
          ? roster
          : roster.filter((row) => row.role === 'teammate' && row.name === (exec.arguments as { name?: unknown }).name)
      if (exec.name === 'spawn_teammate' && rows.length !== 1) return decision
      const expected = exec.name === 'list_agents' ? rows.map(publicMember) : { member: publicMember(rows[0]!) }
      // ToolRuntime exposes no package-origin marker. A name alone is not a
      // sufficient match: preserve custom, policy-replaced and stale results.
      if (!isDeepStrictEqual(result.value, expected)) return decision
      const projected = await Promise.all(
        rows.map(async (row) => {
          const fact = await readModel(row.id, exec.signal)
          if (fact === undefined) return publicMember(row)
          return { ...publicMember(row), model: fact.currentModel }
        }),
      )
      const currentTeams = ctx.get('agentTeams', false)
      const current = currentTeams?.tryMembership(caller)
      if (
        !active ||
        exec.signal.aborted ||
        currentTeams === undefined ||
        current?.root !== membership.root ||
        current?.id !== membership.id ||
        current?.role !== membership.role ||
        current?.name !== membership.name ||
        !isDeepStrictEqual(currentTeams.listMembers(caller), roster)
      )
        return decision
      const value = exec.name === 'list_agents' ? projected : { member: projected[0]! }
      if (isDeepStrictEqual(value, result.value)) return decision
      // Replacing the canonical value lets ToolRuntime validate and render the
      // same facts for native calls, MCP text and nested PTC consumers.
      return {
        kind: 'accept',
        value: value as JsonValue,
        ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
      } satisfies PostToolDecision
    } catch {
      // This observer must not turn a successful coordination operation into
      // failure because model metadata could not be read.
      return decision
    }
  })
  ctx.effect(() => () => {
    active = false
    detach()
  })
}
