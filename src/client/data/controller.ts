/**
 * The ACP settings panel's controller: the one impure seam between the
 * pure logic module and the component tree. It owns the settings-scope
 * subscription and the dshAcp Remote calls (the bypass-endpoint
 * fetches are gone). Every decision is
 * delegated to logic.ts; this file only moves data.
 *
 * store discipline: the controller is glue, not a store. It keeps the
 * authoritative private projection (revision fencing and refresh guards read
 * it) and publishes every transition through the baked store actions bound at
 * `attach` time — the plugin bundle configuration entry declares `store:
 * createAcpPanelStore`, and the inject factory receives the framework-baked
 * actions and hands them here. Attach replays the full projection (`resync`)
 * so a re-created entry store catches up in one publish; while unattached the
 * controller still tracks state and simply has no mirror.
 * @module @zaimokuza/dsh-acp-adapter/client/controller
 */

import {
  decodeBoundSessions,
  decodeHealthResponse,
  decodeHostVersionMismatch,
  errorMessageOf,
  panelSettingsOf,
  validateAgentDraft,
} from './logic.ts'
import type { AcpProviderHealth, AcpScopeSnapshot, AgentDraft } from './logic.ts'
import { acpProbeConfigKey } from '../../contract/agent-config.ts'
import type { AcpRemoteLike } from './acp-remote.ts'
import type { AcpPanelSnapshot, AcpPanelStoreActions, HealthState } from './stores/panel-store.ts'

/** Structural face of the Alpha client settings scope, narrowed to what the panel reads. */
export interface SettingsScopeLike {
  getSnapshot(): AcpScopeSnapshot
  subscribe(listener: () => void): () => void
}

/** One path-addressed settings edit (Alpha Generated Remote settings operation). */
export type AcpSettingsOp = import('@deepseek-ai/dsh-settings/types').SettingsPathOpView

export interface AcpPanelControllerDeps {
  /** The native plugin configuration form, including its revision and write capability. */
  scope: SettingsScopeLike
  /** Settings wire face (write side: path-addressed mutate with revision fencing). */
  mutate(ops: AcpSettingsOp[], expectedRevision?: number): Promise<boolean>
  refusedMessage: () => string
  /** The mounted dshAcp remote namespace; see ./acp-remote.ts. */
  remote: AcpRemoteLike
}

export class AcpPanelController {
  private scopeSnapshot: AcpScopeSnapshot
  private health: HealthState = {
    status: 'idle',
    rows: [],
    fetchedAt: undefined,
    message: undefined,
    checkingAgentIds: [],
    agentErrors: {},
  }
  private sink: AcpPanelStoreActions | null = null
  private readonly unsubscribeScope: () => void
  private readonly remote: AcpRemoteLike
  private readonly write: AcpPanelControllerDeps['mutate']
  private readonly refusedMessage: () => string
  private readonly pendingChecks = new Set<string>()
  private readonly changedDuringRead = new Set<string>()
  private readonly activeAgentChecks = new Map<string, symbol>()
  private disposed = false

  constructor(deps: AcpPanelControllerDeps) {
    this.scopeSnapshot = deps.scope.getSnapshot()
    this.write = deps.mutate
    this.refusedMessage = deps.refusedMessage
    this.remote = deps.remote
    this.unsubscribeScope = deps.scope.subscribe(() => {
      const previous = this.scopeSnapshot.value?.agents
      this.scopeSnapshot = deps.scope.getSnapshot()
      const current = this.scopeSnapshot.value?.agents
      if (previous && current) {
        for (const [id, config] of Object.entries(previous)) {
          const next = current[id]
          if (next !== config && (!next || acpProbeConfigKey(next) !== acpProbeConfigKey(config)))
            this.forgetAgentHealth(id)
        }
      }
      this.sink?.resync(this.project())
    })
  }

  /**
   * Bind the framework-baked store actions (inject factory) and replay the
   * authoritative projection into the fresh store. Re-attach replaces the
   * sink and resyncs again (entry reload path).
   * @param actions - the panel store's baked write set.
   */
  attach(actions: AcpPanelStoreActions): void {
    this.sink = actions
    this.sink.resync(this.project())
  }

  /** Drop the scope subscription and the mirror; the controller publishes nothing afterwards. */
  dispose(): void {
    this.disposed = true
    this.pendingChecks.clear()
    this.activeAgentChecks.clear()
    this.unsubscribeScope()
    this.sink = null
  }

  /**
   * Call the `dshAcp/health` Remote method. Concurrent refreshes fold into the
   * in-flight one; any failure — transport, host-side throw, or a
   * contract-violating payload — lands in 'unreachable' with its message, the
   * graceful-degradation posture for an absent host half.
   * @param recheck - true = 「重新检查」（收尾：host 丢弃 probe 缓存并重探，
   *   面板按钮路径）；false/省略 = 只读缓存视图（面板打开路径，不 spawn probe）。
   */
  async refreshHealth(recheck = false): Promise<void> {
    if (this.health.status === 'loading' || this.health.checkingAgentIds.length > 0) return
    this.health = {
      ...this.health,
      status: 'loading',
      message: undefined,
      checkingAgentIds: [],
      agentErrors: {},
    }
    this.sink?.healthLoading()
    try {
      const result = await this.remote.health(recheck ? { recheck: true } : undefined)
      if (!result.ok) {
        this.failHealth(result.error.message)
        return
      }
      const resultRows = decodeHealthResponse(result.value)
      if (resultRows === undefined) {
        this.failHealth('malformed dshAcp/health payload')
        return
      }
      const rows = resultRows.filter((row) => !this.changedDuringRead.has(row.id))
      const fetchedAt = Date.now()
      const hostVersion = decodeHostVersionMismatch(result.value)
      this.health = {
        status: 'ready',
        rows,
        fetchedAt,
        message: undefined,
        checkingAgentIds: [],
        agentErrors: {},
        ...(hostVersion === undefined ? {} : { hostVersion }),
      }
      this.sink?.healthReady(rows, fetchedAt, hostVersion)
    } catch (error: unknown) {
      this.failHealth(errorMessageOf(error))
    } finally {
      // A panel-wide read replaces all rows. Check Agents saved during it after it settles.
      this.changedDuringRead.clear()
      for (const id of this.pendingChecks) {
        this.pendingChecks.delete(id)
        void this.refreshAgentHealth(id)
      }
    }
  }

  /**
   * Re-probe exactly one configured agent. Different agents may run in
   * parallel; the same agent and a panel-wide refresh are deduplicated. Only
   * the returned target row is merged, preventing out-of-order concurrent
   * responses from rolling another agent back to an older snapshot.
   */
  async refreshAgentHealth(agentId: string): Promise<void> {
    if (this.disposed || this.health.status === 'loading' || this.activeAgentChecks.has(agentId)) return
    const check = Symbol()
    this.activeAgentChecks.set(agentId, check)
    this.health = {
      ...this.health,
      checkingAgentIds: [...this.health.checkingAgentIds, agentId].sort(),
      agentErrors: withoutKey(this.health.agentErrors, agentId),
    }
    this.sink?.agentHealthLoading(agentId)
    try {
      const result = await this.remote.health({ recheck: true, agentId })
      if (this.activeAgentChecks.get(agentId) !== check) return
      if (!result.ok) {
        this.failAgentHealth(agentId, result.error.message)
        return
      }
      const rows = decodeHealthResponse(result.value)
      const row = rows?.find((candidate) => candidate.id === agentId)
      if (row === undefined) {
        this.failAgentHealth(agentId, `health response did not contain agent ${JSON.stringify(agentId)}`)
        return
      }
      const fetchedAt = Date.now()
      this.health = {
        ...this.health,
        status: 'ready',
        rows: mergeHealthRow(this.health.rows, row),
        fetchedAt,
        message: undefined,
        checkingAgentIds: this.health.checkingAgentIds.filter((id) => id !== agentId),
        agentErrors: withoutKey(this.health.agentErrors, agentId),
      }
      this.sink?.agentHealthReady(agentId, row, fetchedAt)
    } catch (error: unknown) {
      if (this.activeAgentChecks.get(agentId) === check) this.failAgentHealth(agentId, errorMessageOf(error))
    } finally {
      if (this.activeAgentChecks.get(agentId) === check) this.activeAgentChecks.delete(agentId)
    }
  }

  /**
   * Write one agent (add, edit, or rename) through the settings wire, fenced
   * by the revision the panel read at. A rename is one atomic mutate (unset +
   * set), so a refused pair cannot strand a half-moved entry. The draft MUST
   * already pass validation — the form gates its save button on it; a failure
   * here is a wiring bug and throws rather than degrading into a silent no-op.
   * @param editingId - the row being edited (undefined while adding).
   * @param draft - the staged form text.
   * @returns the host's refusal message, or undefined once the write landed.
   */
  async saveAgent(editingId: string | undefined, draft: AgentDraft): Promise<string | undefined> {
    const agents = this.scopeSnapshot.value?.agents ?? {}
    const validation = validateAgentDraft(draft, agents, editingId)
    if (validation.config === undefined) {
      throw new Error(
        `AcpPanelController.saveAgent called with an invalid draft (first failure: ${validation.id?.key ?? validation.name?.key ?? validation.command?.key ?? validation.env?.key ?? validation.runtime?.key ?? 'unknown'})`,
      )
    }
    const id = draft.id.trim()
    const ops: AcpSettingsOp[] =
      editingId !== undefined && editingId !== id
        ? [
            { op: 'unset', path: ['agents', editingId] },
            { op: 'set', path: ['agents', id], value: { ...validation.config, args: [...validation.config.args] } },
          ]
        : [{ op: 'set', path: ['agents', id], value: { ...validation.config, args: [...validation.config.args] } }]
    const failure = await this.mutate(ops)
    if (failure === undefined && !this.disposed) {
      const previous = agents[id]
      if (
        editingId === undefined ||
        (editingId === id && previous && acpProbeConfigKey(previous) !== acpProbeConfigKey(validation.config))
      ) {
        if (this.health.status === 'loading') this.pendingChecks.add(id)
        else void this.refreshAgentHealth(id)
      } else if (editingId !== id) {
        this.forgetAgentHealth(editingId)
        this.sink?.resync(this.project())
      }
    }
    return failure
  }

  /**
   * Remove one agent. The unset names its path, so a stale panel cannot delete
   * a row it is not looking at beyond the revision fence.
   * @param id - the agent to remove.
   * @returns the host's refusal message, or undefined once the removal landed.
   */
  async deleteAgent(id: string): Promise<string | undefined> {
    const failure = await this.mutate([{ op: 'unset', path: ['agents', id] }])
    if (failure === undefined) {
      this.forgetAgentHealth(id)
      this.sink?.resync(this.project())
    }
    return failure
  }

  /** Persist the default approval behavior for DSH native tools in new sessions. */
  async setToolApprovalDefault(policy: 'auto' | 'ask'): Promise<string | undefined> {
    if (policy !== 'auto' && policy !== 'ask') throw new TypeError('Invalid DSH tool approval policy')
    return this.mutate([{ op: 'set', path: ['toolApprovalDefault'], value: policy }])
  }

  /**
   * 删除确认提示：该 profile 的既有会话 binding 计数（dshAcp/boundSessions）。
   * RPC 失败/载荷畸形/应答张冠李戴一律归 undefined——计数是确认的增强提示
   * 而非删除门，缺失时面板退回无计数的基础文案（绝不把失败冒充成 0）。
   */
  async countBoundSessions(id: string): Promise<number | undefined> {
    try {
      const result = await this.remote.boundSessions(id)
      if (!result.ok) return undefined
      const view = decodeBoundSessions(result.value)
      return view !== undefined && view.agentId === id ? view.count : undefined
    } catch {
      return undefined
    }
  }

  private async mutate(ops: AcpSettingsOp[]): Promise<string | undefined> {
    const revision = this.scopeSnapshot.revision
    try {
      return (await this.write(ops, revision)) ? undefined : this.refusedMessage()
    } catch (error: unknown) {
      return errorMessageOf(error)
    }
  }

  private failHealth(message: string): void {
    this.health = { ...this.health, status: 'unreachable', message, checkingAgentIds: [] }
    this.sink?.healthUnreachable(message)
  }

  /** An obsolete check must not update a newly saved configuration that uses the same id. */
  private forgetAgentHealth(id: string): void {
    if (this.health.status === 'loading') this.changedDuringRead.add(id)
    this.pendingChecks.delete(id)
    this.activeAgentChecks.delete(id)
    this.health = {
      ...this.health,
      rows: this.health.rows.filter((row) => row.id !== id),
      checkingAgentIds: this.health.checkingAgentIds.filter((checking) => checking !== id),
      agentErrors: withoutKey(this.health.agentErrors, id),
    }
  }

  private failAgentHealth(agentId: string, message: string): void {
    this.health = {
      ...this.health,
      checkingAgentIds: this.health.checkingAgentIds.filter((id) => id !== agentId),
      agentErrors: { ...this.health.agentErrors, [agentId]: message },
    }
    this.sink?.agentHealthFailed(agentId, message)
  }

  private project(): AcpPanelSnapshot {
    return { settings: panelSettingsOf(this.scopeSnapshot), health: this.health }
  }
}

function withoutKey(values: Record<string, string>, key: string): Record<string, string> {
  const next = { ...values }
  delete next[key]
  return next
}

function mergeHealthRow(rows: readonly AcpProviderHealth[], row: AcpProviderHealth): readonly AcpProviderHealth[] {
  const index = rows.findIndex((candidate) => candidate.id === row.id)
  if (index < 0) return [...rows, row].sort((left, right) => left.id.localeCompare(right.id))
  return rows.map((candidate, candidateIndex) => (candidateIndex === index ? row : candidate))
}
