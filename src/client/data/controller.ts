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
 * `attach` time — the `settings.section` entry declares `store:
 * createAcpPanelStore`, and the inject factory receives the framework-baked
 * actions and hands them here. Attach replays the full projection (`resync`)
 * so a re-created entry store catches up in one publish; while unattached the
 * controller still tracks state and simply has no mirror.
 * @module @zaimokuza/dsh-acp-adapter/client/controller
 */

import {
  ACP_SETTINGS_NS,
  decodeBoundSessions,
  decodeHealthResponse,
  errorMessageOf,
  panelSettingsOf,
  validateAgentDraft,
} from './logic.ts'
import type {
  AcpProviderHealth,
  AcpScopeSnapshot,
  AgentDraft,
} from './logic.ts'
import type { AcpRemoteLike } from './acp-remote.ts'
import type { AcpPanelSnapshot, AcpPanelStoreActions, HealthState } from './stores/panel-store.ts'

/** Structural face of the client settings scope (dsh-client-runtime SettingsScope narrowed to what the panel reads). */
export interface SettingsScopeLike {
  getSnapshot(): AcpScopeSnapshot
  subscribe(listener: () => void): () => void
}

/** One path-addressed settings edit (dsh-apiproxy SettingsPathOpView). */
export type AcpSettingsOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** The settings wire face the panel writes through (`connection.api.settings`). */
export interface SettingsMutateLike {
  mutate(request: {
    ns: string
    ops: AcpSettingsOp[]
    expectedRevision?: number
  }): Promise<{ result: { ok: true; value: unknown } | { ok: false; error: { message: string } } }>
}

export interface AcpPanelControllerDeps {
  /** The bound `dsh-acp` settings scope (read side; writes go through `settings`). */
  scope: SettingsScopeLike
  /** Settings wire face (write side: path-addressed mutate with revision fencing). */
  settings: SettingsMutateLike
 /** The mounted dshAcp remote namespace; see ./acp-remote.ts. */
  remote: AcpRemoteLike
}

export class AcpPanelController {
  private scopeSnapshot: AcpScopeSnapshot
  private health: HealthState = {
    status: 'idle', rows: [], fetchedAt: undefined, message: undefined,
    checkingAgentIds: [], agentErrors: {},
  }
  private sink: AcpPanelStoreActions | null = null
  private readonly unsubscribeScope: () => void
  private readonly remote: AcpRemoteLike
  private readonly settingsWire: SettingsMutateLike

  constructor(deps: AcpPanelControllerDeps) {
    this.scopeSnapshot = deps.scope.getSnapshot()
    this.settingsWire = deps.settings
    this.remote = deps.remote
    this.unsubscribeScope = deps.scope.subscribe(() => {
      this.scopeSnapshot = deps.scope.getSnapshot()
      this.sink?.settingsMirrored(panelSettingsOf(this.scopeSnapshot))
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
      const rows = decodeHealthResponse(result.value)
      if (rows === undefined) {
        this.failHealth('malformed dshAcp/health payload')
        return
      }
      const fetchedAt = Date.now()
      this.health = {
        status: 'ready', rows, fetchedAt, message: undefined,
        checkingAgentIds: [], agentErrors: {},
      }
      this.sink?.healthReady(rows, fetchedAt)
    } catch (error: unknown) {
      this.failHealth(errorMessageOf(error))
    }
  }

  /**
   * Re-probe exactly one configured agent. Different agents may run in
   * parallel; the same agent and a panel-wide refresh are deduplicated. Only
   * the returned target row is merged, preventing out-of-order concurrent
   * responses from rolling another agent back to an older snapshot.
   */
  async refreshAgentHealth(agentId: string): Promise<void> {
    if (this.health.status === 'loading' || this.health.checkingAgentIds.includes(agentId)) return
    this.health = {
      ...this.health,
      checkingAgentIds: [...this.health.checkingAgentIds, agentId].sort(),
      agentErrors: withoutKey(this.health.agentErrors, agentId),
    }
    this.sink?.agentHealthLoading(agentId)
    try {
      const result = await this.remote.health({ recheck: true, agentId })
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
      this.failAgentHealth(agentId, errorMessageOf(error))
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
      throw new Error(`AcpPanelController.saveAgent called with an invalid draft (first failure: ${validation.id?.key ?? validation.name?.key ?? validation.command?.key ?? validation.env?.key ?? validation.runtime?.key ?? 'unknown'})`)
    }
    const id = draft.id.trim()
    const ops: AcpSettingsOp[] = editingId !== undefined && editingId !== id
      ? [{ op: 'unset', path: ['agents', editingId] }, { op: 'set', path: ['agents', id], value: validation.config }]
      : [{ op: 'set', path: ['agents', id], value: validation.config }]
    return this.mutate(ops)
  }

  /**
   * Remove one agent. The unset names its path, so a stale panel cannot delete
   * a row it is not looking at beyond the revision fence.
   * @param id - the agent to remove.
   * @returns the host's refusal message, or undefined once the removal landed.
   */
  async deleteAgent(id: string): Promise<string | undefined> {
    return this.mutate([{ op: 'unset', path: ['agents', id] }])
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
      const response = await this.settingsWire.mutate({
        ns: ACP_SETTINGS_NS,
        ops,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      })
      return response.result.ok ? undefined : response.result.error.message
    } catch (error: unknown) {
      return errorMessageOf(error)
    }
  }

  private failHealth(message: string): void {
    this.health = { ...this.health, status: 'unreachable', message, checkingAgentIds: [] }
    this.sink?.healthUnreachable(message)
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
  return rows.map((candidate, candidateIndex) => candidateIndex === index ? row : candidate)
}
