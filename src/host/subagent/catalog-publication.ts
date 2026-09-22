/** Publish durable external-child discovery through DSH's parent-owned catalog. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'

export function installExternalChildCatalog(ctx: Context, store: {
  get(id: string): Session | undefined
  flush(session: Session): Promise<boolean>
}): (header: SessionHeader, label: string) => Promise<void> {
  const pending = new Map<string, Map<string, { header: SessionHeader; label: string }>>()
  const publishing = new Map<string, Promise<void>>()
  let disposed = false
  ctx.effect(() => () => { disposed = true; pending.clear() })
  const publishPending = async (parent: Session): Promise<void> => {
    const children = pending.get(parent.id)
    if (children === undefined) return
    for (const [id, child] of children) {
      if (disposed) return
      const rows = ctx.sessionProjections.snapshot(parent, ['subagentCatalog']).values.subagentCatalog
      // The native Subagent plugin may be absent or still loading. Keep facts
      // queued until it can own discovery; never start an Agent just to list it.
      if (!Array.isArray(rows)) return
      if (!rows.some(row => row.id === id)) parent.append('subagent/catalog', {
        version: 0, childId: child.header.id, childCreatedAt: child.header.createdAt,
        mode: 'one-shot', label: child.label,
      })
      if (!(await store.flush(parent))) throw new Error('ACP_SUBAGENT_CATALOG_NOT_DURABLE')
      children.delete(id)
    }
    if (children.size === 0) pending.delete(parent.id)
  }
  const publish = (parent: Session): Promise<void> => {
    const previous = publishing.get(parent.id) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => publishPending(parent))
    publishing.set(parent.id, task)
    const release = (): void => { if (publishing.get(parent.id) === task) publishing.delete(parent.id) }
    void task.then(release, release)
    return task
  }
  const resume = (parent: Session): void => {
    void publish(parent).catch(() => ctx.logger.warn('ACP external-child catalog publication will be retried when the parent is reopened.'))
  }
  ctx.on('session/created', resume)
  ctx.inject(['subagents'], () => {
    for (const id of pending.keys()) {
      const parent = store.get(id)
      if (parent !== undefined) resume(parent)
    }
  })
  return async (header, label) => {
    if (disposed || header.parentSession === undefined) return
    const children = pending.get(header.parentSession) ?? new Map()
    children.set(header.id, { header, label })
    pending.set(header.parentSession, children)
    const parent = store.get(header.parentSession)
    if (parent !== undefined) await publish(parent)
  }
}
