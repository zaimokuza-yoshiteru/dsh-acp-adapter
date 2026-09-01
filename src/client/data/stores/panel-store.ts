/**
 * The ACP settings panel's store seat: the `settings.section`
 * registration declares `store: createAcpPanelStore` (exclusive factory — the
 * framework mints the handle per entry; nothing module-level), and the glue
 * controller publishes through the baked actions it receives at attach time.
 *
 * State and its semantic write set live here (the store IS the view-facing
 * audit face); the controller keeps the authoritative private projection
 * (scope guards and revision fencing read it) and mirrors every transition
 * through these actions, resyncing wholesale on attach so a re-created entry
 * store catches up in one publish.
 * @module @zaimokuza/dsh-acp-adapter/client/stores/panel-store
 */

import type { AcpProviderHealth, PanelSettingsState } from '../logic.ts'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { ActionsDecl, BakedActions, StoreHandle } from '@deepseek-ai/dsh-client-store'

/** The panel's health state: the last good rows ride through later failures so a refresh error erases nothing. */
export interface HealthState {
  /** 'idle' until the panel first mounts; 'unreachable' = the dshAcp Remote namespace cannot be reached (host half absent/down). */
  status: 'idle' | 'loading' | 'ready' | 'unreachable'
  rows: readonly AcpProviderHealth[]
  fetchedAt: number | undefined
  message: string | undefined
  /** 正在执行卡片级检查的 agent；不同 agent 可并行，同一 agent 自动去重。 */
  checkingAgentIds: string[]
  /** 卡片级检查的传输/载荷错误；成功重检或全量刷新会清除对应错误。 */
  agentErrors: Record<string, string>
}

/** The panel store's published snapshot. */
export interface AcpPanelSnapshot {
  settings: PanelSettingsState
  health: HealthState
}

const initialPanelState = (): AcpPanelSnapshot => ({
  // 与 controller 的首投影同形：scope 尚未 ready 时面板显示 loading（attach
  // 时的 resync 会立刻把真实投影灌进来，这只是工厂播种值）。
  settings: { status: 'loading', writable: false, agents: {}, revision: undefined },
  health: {
    status: 'idle', rows: [], fetchedAt: undefined, message: undefined,
    checkingAgentIds: [], agentErrors: {},
  },
})

/** The panel's complete write set — every glue publish routes through one of these. */
const panelActions = {
  /** Mirror the settings scope's current projection (scope subscription + attach resync). */
  settingsMirrored(draft: AcpPanelSnapshot, settings: PanelSettingsState): void {
    draft.settings = settings
  },
  /** A health refresh started (concurrent refreshes fold in the glue). */
  healthLoading(draft: AcpPanelSnapshot): void {
    draft.health.status = 'loading'
    draft.health.message = undefined
    draft.health.checkingAgentIds = []
    draft.health.agentErrors = {}
  },
  /** A refresh landed: rows replace wholesale, the error clears. */
  healthReady(
    draft: AcpPanelSnapshot,
    rows: readonly AcpProviderHealth[],
    fetchedAt: number,
  ): void {
    draft.health = {
      status: 'ready', rows, fetchedAt, message: undefined,
      checkingAgentIds: [], agentErrors: {},
    }
  },
  /** A refresh failed (network/HTTP/malformed): keep the last good rows, surface the message. */
  healthUnreachable(draft: AcpPanelSnapshot, message: string): void {
    draft.health.status = 'unreachable'
    draft.health.message = message
    draft.health.checkingAgentIds = []
  },
  /** One card started a targeted probe; other cards remain interactive. */
  agentHealthLoading(draft: AcpPanelSnapshot, agentId: string): void {
    if (!draft.health.checkingAgentIds.includes(agentId)) {
      draft.health.checkingAgentIds.push(agentId)
      draft.health.checkingAgentIds.sort()
    }
    delete draft.health.agentErrors[agentId]
  },
  /** Merge only the checked row so concurrent checks cannot overwrite each other. */
  agentHealthReady(
    draft: AcpPanelSnapshot,
    agentId: string,
    row: AcpProviderHealth,
    fetchedAt: number,
  ): void {
    draft.health.status = 'ready'
    draft.health.message = undefined
    draft.health.checkingAgentIds = draft.health.checkingAgentIds.filter((id) => id !== agentId)
    delete draft.health.agentErrors[agentId]
    const index = draft.health.rows.findIndex((candidate) => candidate.id === agentId)
    draft.health.rows = index < 0
      ? [...draft.health.rows, row].sort((left, right) => left.id.localeCompare(right.id))
      : draft.health.rows.map((candidate, candidateIndex) => candidateIndex === index ? row : candidate)
    draft.health.fetchedAt = fetchedAt
  },
  /** A targeted transport/contract failure belongs to that card, not the whole panel. */
  agentHealthFailed(draft: AcpPanelSnapshot, agentId: string, message: string): void {
    draft.health.checkingAgentIds = draft.health.checkingAgentIds.filter((id) => id !== agentId)
    draft.health.agentErrors[agentId] = message
  },
  /**
   * Wholesale projection resync: the attach path replays the glue's
   * authoritative state into a fresh store in one publish.
   */
  resync(draft: AcpPanelSnapshot, next: AcpPanelSnapshot): void {
    draft.settings = next.settings
    draft.health = next.health
  },
} satisfies ActionsDecl<AcpPanelSnapshot>

/** Baked (draft-stripped) form the glue receives at attach time. */
export type AcpPanelStoreActions = BakedActions<AcpPanelSnapshot, typeof panelActions>

/**
 * The exclusive-factory registration currency of the panel's store seat.
 * @returns a fresh handle (one per entry — never share at module level).
 */
export function createAcpPanelStore(): StoreHandle<AcpPanelSnapshot, typeof panelActions> {
  return defineStore({ init: initialPanelState, actions: panelActions })
}
