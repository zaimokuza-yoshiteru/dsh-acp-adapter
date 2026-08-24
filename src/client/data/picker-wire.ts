/**
 * Shared structural wire faces of the picker glue: the
 * dsh-apiproxy result envelope and the sessions/settings wire shapes, narrowed
 * structurally — this layer never value-imports cordis or the client runtime
 * (test/contracts/architecture.spec.ts pins zero external imports for clientData).
 * @module @zaimokuza/dsh-acp-adapter/client/picker-wire
 */

import type { PickerModelSelection, PickerSettingsOp, SessionModelsView } from './selector-logic.ts'

/** dsh-apiproxy 结果信封（与 controller.ts SettingsMutateLike 同款）。 */
export type WireResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Render a refused wire call as `code: message` (the store-facing error vocabulary). */
export function wireFailure(result: WireResult<unknown>): string {
  return result.ok ? '' : `${result.error.code}: ${result.error.message}`
}

/** The sessions wire face the picker reads/writes (`connection.api.sessions`). */
export interface SessionsWireLike {
  models(input: { sessionId: string }): Promise<{ result: WireResult<SessionModelsView> }>
  selectModel(input: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{ result: WireResult<{ selected: PickerModelSelection }> }>
  /**
 * 公开 wire RPC `session.create`（rc.2 SessionsApi.create，
   * reference/deepseek-harness packages/host/apiproxy/src/api/sessions.ts:265：
   * 载荷接受调用方预分配的 sessionId + workspaceId/cwd 二选一；host 对同 id
   * 同 cwd 的重试幂等——ensureSession 采用活体/持久会话，不重复创建）。
   * `workspace-attach-failed` 错误码 = 会话已发布但工作区挂载失败（未分组）。
   */
  create(input: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
  }): Promise<{ result: WireResult<{ sessionId: string }> }>
}

/** 与 controller.ts `SettingsMutateLike` 同形（default-model 写入面）。 */
export interface SettingsWireLike {
  mutate(request: {
    ns: string
    ops: PickerSettingsOp[]
    expectedRevision?: number
  }): Promise<{ result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } } }>
}
