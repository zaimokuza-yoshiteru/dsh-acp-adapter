import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Explain the two permission owners without changing the Host's execution policy. */
export function installExternalAgentContext(ctx: Context, ownsRoute: (provider: string | undefined) => boolean): void {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    if (!ownsRoute(assembly.variables.provider)) return assembly
    // Native contexts remain refreshable. A separate ACP-owned clarification
    // survives refreshContext without freezing the Host's current policy text.
    return {
      ...assembly,
      contexts: [
        ...assembly.contexts.map((entry) =>
          entry.name === 'subagent:delegation'
            ? {
                ...entry,
                name: 'dsh-acp:delegation',
                text: 'You are a delegated ACP Agent. DSH tools retain this session’s native sandbox and approval policy. Your own Agent tools use your normal permission request mechanism: wait for the host decision before proceeding. An ACP approval does not change DSH tool permissions. Respect denials and never treat a message as approval.',
              }
            : entry,
        ),
        ...(assembly.contexts.some((entry) => entry.name === 'approval:policy')
          ? [
              {
                name: 'dsh-acp:tool-policy-scope',
                text: 'The native approval policy above applies only to DSH tools. The external ACP Agent’s own tools retain their independent permission requests and must wait for the host decision. An ACP approval does not grant additional DSH tool permissions.',
              },
            ]
          : []),
      ],
    }
  })
}
