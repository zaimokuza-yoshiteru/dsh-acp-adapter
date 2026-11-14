import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './session-facts.ts'
import { acpAgentIdFromRoute } from '../../domain/session/agent-config.ts'

/** Guard Git effects early and use native directory admission for every direct caller. */
export function installWorkingDirectoryGuard(
  ctx: Context,
  adapterFor: (profileId: string) =>
    | {
        workingDirectoryChangeDenial(sessionId: string, owner: object): string | undefined
      }
    | undefined,
  readBinding?: (sessionId: SessionId) => Promise<unknown | undefined>,
): void {
  const profileOf = (agent: Agent): string | undefined => {
    const provider = agent.session.requestHeader()?.config.provider ?? agent.options.provider
    return provider === undefined ? undefined : acpAgentIdFromRoute(provider)
  }
  // A seeded child can have its parent's header before its own first request.
  const beforeOwnRequest = (agent: Agent): boolean =>
    agent.session.requestHeader() === undefined ||
    ctx.get('acpSessionFacts')?.read(agent.session).soleRequestProvider === null
  const denialFor = (agent: Agent, requireRunning = false): HarnessError | undefined => {
    const profileId = profileOf(agent)
    if (profileId === undefined) return
    const adapter = adapterFor(profileId)
    if (adapter === undefined)
      return new HarnessError(
        'ACP_WORKING_DIRECTORY_UNAVAILABLE: The ACP route is unavailable; the working directory was not changed.',
        'ACP_WORKING_DIRECTORY_UNAVAILABLE',
      )
    const denial = adapter.workingDirectoryChangeDenial(agent.id, agent.session)
    if (denial !== undefined) return new HarnessError(denial, 'ACP_WORKING_DIRECTORY_UNSUPPORTED')
    // A settled Session has no active ACP stream to own the existing fork handoff.
    if (requireRunning && agent.status !== 'running')
      return new HarnessError(
        'This ACP conversation cannot change its working directory while idle. Open a separate session in the target directory.',
        'ACP_WORKING_DIRECTORY_UNSUPPORTED',
      )
    return undefined
  }
  ctx.inject(['tools'], (child) =>
    child.tools.guard((exec) => {
      if (exec.agent === undefined) return
      if (exec.name !== 'create_worktree') return
      const denial = denialFor(exec.agent)
      if (denial !== undefined) return { reason: denial.message, info: { name: denial.name, code: denial.code } }
    }),
  )
  ctx.inject(['workingDirectory', 'fs'], (child) => {
    child.on('working-directory/access', async ({ agent, path, signal }, next) => {
      const profileId = profileOf(agent)
      if (profileId === undefined || path === '') return next()
      const registry = child.get('agents', false)
      const initialEntry = registry?.get(agent.id)
      const registryIdentity =
        registry === undefined ? undefined : (Reflect.get(registry, symbols.original) ?? registry)
      const assertOwner = (allowUnpublished = false) => {
        signal.throwIfAborted()
        child.fiber.assertActive()
        agent.ctx.fiber.assertActive()
        const activeRegistry = child.get('agents', false)
        const activeIdentity =
          activeRegistry === undefined ? undefined : (Reflect.get(activeRegistry, symbols.original) ?? activeRegistry)
        const registered = activeRegistry?.get(agent.id)
        // Native child setup sets its initial directory before agents.enter().
        const unpublished =
          allowUnpublished && initialEntry === undefined && registered === undefined && beforeOwnRequest(agent)
        if (
          profileOf(agent) !== profileId ||
          activeIdentity !== registryIdentity ||
          (registry !== undefined && registered !== agent && !unpublished)
        )
          throw new HarnessError(
            'The ACP session owner changed; the working directory was not changed.',
            'ACP_WORKING_DIRECTORY_UNAVAILABLE',
          )
      }
      const current = child.workingDirectory.get(agent.session)
      const original = agent.session.header.cwd ?? child.workingDirectory.defaultDirectory
      // A normal ensure validates this same path; no ACP handoff is needed,
      // including initial system-prompt assembly before an ACP binding exists.
      if (path === null && current === original) return next()
      let target = await child.fs.resolve(path ?? current, { cwd: current, signal })
      let info = await child.fs.stat(target, signal)
      signal.throwIfAborted()
      if (path === null) {
        if (info?.type === 'directory') return next()
        // ensure may restore the origin. Admit that transition before its native commit.
        target = await child.fs.resolve(original, { cwd: original, signal })
        info = await child.fs.stat(target, signal)
        signal.throwIfAborted()
      }
      // Preserve the native invalid/missing-directory error and its no-commit behavior.
      if (info?.type !== 'directory') return next()
      const currentTarget = await child.fs.resolve(current, { signal })
      if (child.fs.processPath(target) === child.fs.processPath(currentTarget)) return next()
      assertOwner(true)
      if (beforeOwnRequest(agent) && readBinding !== undefined) {
        let binding: unknown
        try {
          binding = await readBinding(agent.id)
        } catch (cause) {
          throw new HarnessError(
            'The ACP conversation state could not be checked; the working directory was not changed.',
            'ACP_WORKING_DIRECTORY_UNAVAILABLE',
            { cause },
          )
        }
        assertOwner(true)
        if (binding === undefined && beforeOwnRequest(agent)) return next()
      }
      assertOwner()
      const denial = denialFor(agent, true)
      if (denial !== undefined) throw denial
      return next()
    })
  })
}
