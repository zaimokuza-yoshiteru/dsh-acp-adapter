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

import type { AcpProviderHealth, AcpSandboxFact, PanelSettingsState } from '../logic.ts'
import { defineSnapshotStore } from './engine.ts'
import type { ActionsDecl, BakedActions, StoreHandle } from './engine.ts'

/** The panel's health state: the last good rows ride through later failures so a refresh error erases nothing. */
export interface HealthState {
  /** 'idle' until the panel first mounts; 'unreachable' = the dshAcp Remote namespace cannot be reached (host half absent/down). */
  status: 'idle' | 'loading' | 'ready' | 'unreachable'
  rows: readonly AcpProviderHealth[]
 /** 本平台沙箱 enforcement 事实（health 响应顶层 `sandbox` 字段的容忍式解码结果）。与 rows 同款纪律：只在成功刷新时更新，刷新失败保留上一份。 */
  sandbox: AcpSandboxFact | null
  fetchedAt: number | undefined
  message: string | undefined
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
  health: { status: 'idle', rows: [], sandbox: null, fetchedAt: undefined, message: undefined },
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
  },
  /** A refresh landed: rows/sandbox replace wholesale, the error clears. */
  healthReady(
    draft: AcpPanelSnapshot,
    rows: readonly AcpProviderHealth[],
    sandbox: AcpSandboxFact | null,
    fetchedAt: number,
  ): void {
    draft.health = { status: 'ready', rows, sandbox, fetchedAt, message: undefined }
  },
  /** A refresh failed (network/HTTP/malformed): keep the last good rows, surface the message. */
  healthUnreachable(draft: AcpPanelSnapshot, message: string): void {
    draft.health.status = 'unreachable'
    draft.health.message = message
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
  return defineSnapshotStore({ init: initialPanelState, actions: panelActions })
}
