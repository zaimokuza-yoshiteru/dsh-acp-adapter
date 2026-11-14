import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpApprovalChildView } from '../../contract/remote.ts'
import { captureSubagentTree, localSubagentIdentity, subagentPath } from './tree.ts'

/** Discover live local ACP descendants without requiring their creators to remain resident. */
export function createApprovalChildrenReader(ctx: Context, owns: (provider: string) => boolean) {
  return async (parentId: string): Promise<readonly AcpApprovalChildView[]> => {
    const agents = ctx.get('agents', false)
    const root = agents?.get(parentId as SessionId)
    const tree = root === undefined ? undefined : captureSubagentTree(ctx, root)
    if (agents === undefined || root === undefined || tree?.root !== root) return []
    const rows = await tree.descendants()
    const result: AcpApprovalChildView[] = []
    for (const child of agents.list()) {
      const provider = child.session.requestHeader()?.config.provider ?? child.options.provider
      if (provider === undefined || !owns(provider)) continue
      const identity = localSubagentIdentity(ctx, child)
      const member = captureSubagentTree(ctx, child)
      if (identity === undefined || member?.root !== root) continue
      const path = subagentPath(root.id, child.id, rows)
      const parent = child.session.header.parentSession
      if (path === undefined || parent === undefined) continue
      result.push({
        sessionId: child.id,
        parentSessionId: parent,
        name: member.names().self,
        mode: identity.mode,
        path,
      })
    }
    return tree.current() ? result : []
  }
}
